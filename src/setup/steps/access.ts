/**
 * Schritt „zugang“ (Issue #231): Zugang vom Handy. Die Web-App lässt sich nur
 * über HTTPS installieren und Benachrichtigungen schicken (Entscheidung
 * 0021), im Heimnetz läuft die WebUI über http. Drei Wege:
 *
 * - tailscale: `tailscale serve` im eigenen Tailnet (../tailscale.ts),
 *   läuft als Ablauf; schreibt WEB_PUBLIC_ORIGIN mit der ts.net-Adresse
 * - cloudflare: Cloudflare Tunnel mit eigener Domain und Access
 *   (Entscheidung 0014, docs/webui/fernzugang.md); schreibt
 *   WEB_PUBLIC_ORIGIN, WEB_ACCESS_TEAM, WEB_ACCESS_AUD und WEB_PORT
 * - lokal: keinen zusätzlichen Zugang einrichten, nichts ändern
 *
 * Installiert nichts (weder Tailscale noch cloudflared) und ändert keinen
 * Tunnel. Ein vorhandener Zugang wird nie still ersetzt: Wer den Weg
 * wechselt, bestätigt das ausdrücklich (ZUGANG_ERSETZEN), sonst bleibt alles.
 * Eine vorhandene Serve-Einstellung auf Port 443 wird nur übernommen, wenn
 * sie genau auf die WebUI zeigt, sonst nicht angefasst.
 *
 * Die WebUI liest die neuen Werte erst nach einem Neustart, und unter
 * `tybo setup --web` belegt der Assistent selbst ihren Port. Der Test über
 * HTTPS ist deshalb getrennt vom Einrichten: kann er noch nichts nachweisen,
 * heißt er „ausstehend“ und nennt, wie man ihn nachholt.
 *
 * Die öffentliche Adresse steht nicht als Feld WEB_PUBLIC_ORIGIN im Schritt
 * (Freitextfelder werden im Browser aus allen Meldungen geschwärzt, die
 * Adresse fürs Handy soll aber lesbar bleiben): der Cloudflare-Weg fragt die
 * Domain als ZUGANG_DOMAIN, der Tailscale-Weg liest sie aus tailscale.
 */

import { BRAND } from "../../brand";
import { DEFAULT_WEB_PORT, isTailscaleOrigin, loadWebConfig, parseAccessConfig, parsePublicOrigin } from "../../web/config";
import { MANIFEST_PATH } from "../../web/manifest";
import { readSetupEnv, type SetupContext } from "../context";
import {
  fieldStates,
  mergeValues,
  presentValue,
  type ApplyResult,
  type RunReport,
  type SetupField,
  type SetupStep,
  type SetupValues,
  type StatusItem,
  type StepStatus,
  type TestResult,
} from "../model";
import {
  enableServe,
  manualCheckCommand,
  probeHttps,
  readServeState,
  readTailscaleStatus,
  serveTarget,
  TAILSCALE_TEXT,
  type HttpsProbe,
} from "../tailscale";
import { invalid, writeEnv } from "./common";

export const ACCESS_PATH_FIELD = "ZUGANG_WEG";
export const ACCESS_REPLACE_FIELD = "ZUGANG_ERSETZEN";
export const ACCESS_DOMAIN_FIELD = "ZUGANG_DOMAIN";

export type AccessPath = "tailscale" | "cloudflare" | "lokal";
type RemotePath = Exclude<AccessPath, "lokal">;

type Env = Record<string, string | undefined>;

/** Weg nach WEB_PUBLIC_ORIGIN: ts.net ist Tailscale, sonst Cloudflare; null ohne Adresse */
export function currentAccessPath(env: Env): RemotePath | null {
  const origin = presentValue(env, "WEB_PUBLIC_ORIGIN");
  if (!origin) return null;
  return isTailscaleOrigin(origin) ? "tailscale" : "cloudflare";
}

/** Eingerichteter Weg für Vorauswahl und Wechsel: Access-Werte gehören immer zu Cloudflare */
function configuredPath(env: Env): RemotePath | null {
  if (presentValue(env, "WEB_ACCESS_TEAM") || presentValue(env, "WEB_ACCESS_AUD")) return "cloudflare";
  return currentAccessPath(env);
}

const PATH_TITLE: Record<RemotePath, string> = {
  tailscale: "Tailscale",
  cloudflare: "Cloudflare Tunnel",
};

const isPath = (path: AccessPath) => (v: SetupValues) => v[ACCESS_PATH_FIELD] === path;

/** Der gewählte Weg ist ein anderer als der eingerichtete (lokal ändert nie etwas) */
const switching = (v: SetupValues) =>
  !!v.ZUGANG_BISHER && !!v[ACCESS_PATH_FIELD] && v[ACCESS_PATH_FIELD] !== "lokal" && v[ACCESS_PATH_FIELD] !== v.ZUGANG_BISHER;

/** Domain oder https-Adresse zur öffentlichen Adresse (https://<domain>); null, wenn ungültig */
export function domainOrigin(value: string): string | null {
  const v = value.trim().replace(/\/$/, "");
  return parsePublicOrigin(/^https:\/\//i.test(v) ? v : `https://${v}`);
}

const TEAM_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const ACCESS_FIELDS: SetupField[] = [
  {
    name: ACCESS_PATH_FIELD,
    label: "Weg vom Handy",
    kind: "choice",
    required: true,
    default: "tailscale",
    help: "Die Web-App auf dem Handy (installieren, Benachrichtigungen) braucht eine HTTPS-Adresse. Tailscale ist ein privates Netz nur für deine Geräte und am einfachsten. Cloudflare braucht eine eigene Domain. „Nur auf diesem Rechner“ richtet nichts ein.",
    choices: [
      { value: "tailscale", label: "Tailscale, privates Netz nur für deine Geräte (empfohlen)" },
      { value: "cloudflare", label: "Cloudflare Tunnel mit eigener Domain und Cloudflare Access" },
      { value: "lokal", label: "Nur auf diesem Rechner, keinen zusätzlichen Zugang einrichten" },
    ],
  },
  {
    name: ACCESS_REPLACE_FIELD,
    label: "Vorhandenen Zugang ersetzen",
    kind: "yesno",
    transient: true,
    required: true,
    help: "Es ist schon ein anderer Weg eingerichtet. Ja ersetzt dessen Werte in der .env; Tunnel oder Tailscale-Einstellungen selbst bleiben unverändert. Nein ändert nichts.",
    visible: switching,
  },
  {
    name: ACCESS_DOMAIN_FIELD,
    label: "Adresse von unterwegs (eigene Domain)",
    kind: "text",
    required: true,
    help: "Unter dieser Adresse soll die WebUI erreichbar sein, etwa tybo.example.org. Die Domain muss bei Cloudflare liegen; vorher den Tunnel-Eintrag und die Access-Anwendung anlegen (Anleitung: docs/webui/fernzugang.md).",
    link: "https://one.dash.cloudflare.com/",
    visible: isPath("cloudflare"),
    validate: v => {
      const origin = domainOrigin(v);
      if (!origin) return "Adresse von unterwegs: nur eine Domain wie tybo.example.org, ohne Pfad und Port";
      if (isTailscaleOrigin(origin)) return "Adresse von unterwegs: eine ts.net-Adresse gehört zu Tailscale, dafür den Weg Tailscale wählen";
      return null;
    },
  },
  {
    name: "WEB_ACCESS_TEAM",
    label: "Cloudflare-Team-Name",
    kind: "text",
    required: true,
    help: "Zero Trust, Settings, Custom Pages, Feld „Team domain“, etwa meinteam.cloudflareaccess.com. Der Team-Name ist der erste Teil (meinteam); die ganze Adresse geht auch.",
    link: "https://one.dash.cloudflare.com/",
    visible: isPath("cloudflare"),
    validate: v => {
      const team = v.trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/$/, "").replace(/\.cloudflareaccess\.com$/, "");
      return TEAM_PATTERN.test(team) ? null : "Cloudflare-Team-Name: nur a-z, 0-9 und -, etwa meinteam";
    },
  },
  {
    name: "WEB_ACCESS_AUD",
    label: "Application Audience (AUD) Tag",
    kind: "text",
    required: true,
    help: "Zero Trust, Access, Applications, die Anwendung zur Domain, Configure, Overview: „Application Audience (AUD) Tag“, eine lange Zeichenkette aus Ziffern und a bis f.",
    link: "https://one.dash.cloudflare.com/",
    visible: isPath("cloudflare"),
    validate: v => (/^[A-Za-z0-9_-]{16,128}$/.test(v.trim()) ? null : "Application Audience (AUD) Tag: ungültig, bitte genau aus Cloudflare kopieren"),
  },
];

/**
 * Vorhandene Werte für Sichtbarkeit und Vorauswahl (existingFieldValues in
 * ../steps.ts): der eingerichtete Weg als Vorauswahl und als ZUGANG_BISHER,
 * beim Cloudflare-Weg die Domain. Nur intern, geht nie an die Oberfläche.
 */
export async function accessPathValues(ctx: SetupContext): Promise<SetupValues> {
  const env = await readSetupEnv(ctx);
  const path = configuredPath(env);
  if (!path) return {};
  const out: SetupValues = { [ACCESS_PATH_FIELD]: path, ZUGANG_BISHER: path };
  const origin = presentValue(env, "WEB_PUBLIC_ORIGIN");
  if (path === "cloudflare" && origin && !isTailscaleOrigin(origin)) {
    const parsed = parsePublicOrigin(origin);
    if (parsed) out[ACCESS_DOMAIN_FIELD] = new URL(parsed).host;
  }
  return out;
}

/** Satz, wenn die WebUI aus ist: ohne sie gibt es nichts zu erreichen */
export const ACCESS_NEEDS_WEBUI = "Die WebUI ist aus. Zugang vom Handy gibt es nur mit eingeschalteter WebUI: erst den Schritt WebUI einrichten.";

export const LOCAL_ONLY_TEXT =
  "Kein zusätzlicher Zugang eingerichtet. Die WebUI bleibt, wie sie ist (dieser Rechner bzw. Heimnetz). Als App aufs Handy legen und Benachrichtigungen gehen damit nicht, dafür braucht es HTTPS.";

/** Hinweis nach dem Speichern: die WebUI liest die Werte erst beim Start */
export const RESTART_HINT = `${BRAND.name} nutzt die neuen Werte ab dem nächsten Start. Läuft ${BRAND.name} schon: in der WebUI unter Einstellungen, Status „Neustart anfordern“.`;

export const ACCESS_SESSION_HINT =
  "Tipp: In der Access-Anwendung die Session duration für die App auf dem Handy eher auf 30 Tage stellen statt 24 Stunden, sonst fragt Cloudflare jeden Tag nach einem neuen Code.";

async function accessStatus(ctx: SetupContext): Promise<StepStatus> {
  const env = await readSetupEnv(ctx);
  // Der Weg steht nicht als eigene Variable in der .env, das Bestätigungsfeld gilt nur für einen Lauf
  const fields = fieldStates(ACCESS_FIELDS, {
    ...(presentValue(env, "WEB_ACCESS_TEAM") ? { WEB_ACCESS_TEAM: "x" } : {}),
    ...(presentValue(env, "WEB_ACCESS_AUD") ? { WEB_ACCESS_AUD: "x" } : {}),
    ...(currentAccessPath(env) === "cloudflare" ? { [ACCESS_DOMAIN_FIELD]: "x" } : {}),
  });
  const web = loadWebConfig(env);
  if (web.status === "disabled") return { state: "fehlt", detail: ACCESS_NEEDS_WEBUI, fields };
  if (web.status === "invalid") return { state: "teilweise", detail: `WebUI startet nicht: ${web.reason}.`, fields };
  const path = currentAccessPath(env);
  if (!path) {
    return { state: "fehlt", detail: "Nur auf diesem Rechner bzw. im Heimnetz. Für die App auf dem Handy fehlt eine HTTPS-Adresse.", fields };
  }
  if (path === "tailscale") {
    if (web.config.access) {
      return {
        state: "teilweise",
        detail: "WEB_PUBLIC_ORIGIN ist eine Tailscale-Adresse, dazu stehen Cloudflare-Access-Werte in der .env: Anfragen von unterwegs werden abgelehnt.",
        fields,
      };
    }
    return { state: "erledigt", detail: "Zugang über Tailscale ist eingerichtet.", fields };
  }
  if (!web.config.access) {
    return { state: "teilweise", detail: "WEB_PUBLIC_ORIGIN ist gesetzt, Cloudflare Access fehlt (WEB_ACCESS_TEAM, WEB_ACCESS_AUD).", fields };
  }
  return { state: "erledigt", detail: `Zugang über ${PATH_TITLE.cloudflare} mit Cloudflare Access ist eingerichtet.`, fields };
}

/** Werte des Schritts: Eingaben über den vorhandenen (Weg, Domain, Access-Werte) */
async function mergedValues(values: SetupValues, ctx: SetupContext): Promise<{ env: Env; merged: SetupValues; existing: SetupValues }> {
  const env = await readSetupEnv(ctx);
  const existing: SetupValues = { ...(await accessPathValues(ctx)) };
  for (const name of ["WEB_ACCESS_TEAM", "WEB_ACCESS_AUD"]) {
    const v = presentValue(env, name);
    if (v) existing[name] = v;
  }
  return { env, existing, merged: mergeValues(existing, values) };
}

/** Wechsel ohne Bestätigung: nichts ändern, das sagen */
function keptBecauseNotConfirmed(before: RemotePath): ApplyResult {
  return { ok: true, message: `Nichts geändert: der vorhandene Zugang über ${PATH_TITLE[before]} bleibt.`, changed: [] };
}

// ---------------------------------------------------------------------------
// Tailscale
// ---------------------------------------------------------------------------

const TS_TOTAL = 5;

function probeText(probe: HttpsProbe, origin: string): string {
  const check = `Nachholen mit „${BRAND.cli} setup zugang“ oder im Terminal: ${manualCheckCommand(origin)} (erwartet: eine Antwort mit "name":"${BRAND.name}").`;
  if (probe.state === "ok") return `Test über HTTPS bestanden: ${BRAND.name} antwortet unter ${origin}.`;
  if (probe.state === "ausstehend") return `Test über HTTPS ausstehend: ${probe.reason} ${check}`;
  return `Test über HTTPS fehlgeschlagen: ${probe.reason} ${check}`;
}

/** Test über HTTPS, im Browser-Assistenten nicht (er belegt den Port der WebUI) */
async function httpsProbe(ctx: SetupContext, origin: string, signal?: AbortSignal): Promise<HttpsProbe> {
  if (ctx.browserSetup) {
    return { state: "ausstehend", reason: `Der Einrichtungsassistent im Browser belegt gerade den Port der WebUI; getestet werden kann erst, wenn ${BRAND.name} läuft.` };
  }
  return probeHttps(ctx, origin, signal);
}

async function runTailscale(values: SetupValues, ctx: SetupContext, report: RunReport, signal: AbortSignal): Promise<ApplyResult> {
  const { env, existing, merged } = await mergedValues(values, ctx);
  const problem = invalid(ACCESS_FIELDS, values, existing);
  if (problem) return { ...problem, changed: [] };
  const web = loadWebConfig(env);
  if (web.status === "disabled") return { ok: false, message: ACCESS_NEEDS_WEBUI, changed: [] };
  if (web.status === "invalid") return { ok: false, message: `Die WebUI startet so nicht: ${web.reason}. Erst den Schritt WebUI richten.`, changed: [] };
  const before = configuredPath(env);
  const replacing = before === "cloudflare";
  if (replacing && merged[ACCESS_REPLACE_FIELD] !== "true") return keptBecauseNotConfirmed(before);
  const port = web.config.port;

  report({ at: 1, total: TS_TOTAL, label: "Tailscale prüfen (installiert, angemeldet, MagicDNS, HTTPS-Zertifikate)" });
  const status = await readTailscaleStatus(ctx, signal);
  if (signal.aborted) return aborted([]);
  if (!status.ok) return { ok: false, message: TAILSCALE_TEXT[status.problem], changed: [] };

  report({ at: 2, total: TS_TOTAL, label: "Vorhandene Serve-Einstellung auf Port 443 prüfen" });
  const serve = await readServeState(ctx, status.bin, status.host, port, signal);
  if (signal.aborted) return aborted([]);
  if ("problem" in serve) return { ok: false, message: TAILSCALE_TEXT[serve.problem], changed: [] };
  if (serve.state === "belegt") return { ok: false, message: TAILSCALE_TEXT.busy, changed: [] };
  if (serve.state === "funnel") return { ok: false, message: TAILSCALE_TEXT.funnel, changed: [] };

  const changed: string[] = [];
  if (serve.state === "frei") {
    report({ at: 3, total: TS_TOTAL, label: "Weiterleitung einrichten (tailscale serve im Hintergrund)" });
    const failed = await enableServe(ctx, status.bin, port, signal);
    if (signal.aborted) return aborted([]);
    if (failed) return { ok: false, message: TAILSCALE_TEXT[failed], changed: [] };
    const check = await readServeState(ctx, status.bin, status.host, port, signal);
    if (!("state" in check) || check.state !== "webui") return { ok: false, message: TAILSCALE_TEXT.serveFailed, changed: [] };
    changed.push(`tailscale serve: https://${status.host} → ${serveTarget(port)}`);
  } else {
    report({ at: 3, total: TS_TOTAL, label: "Weiterleitung ist schon eingerichtet" });
  }

  report({ at: 4, total: TS_TOTAL, label: "Adresse in die .env schreiben" });
  const changes: Array<[string, string | null]> = [["WEB_PUBLIC_ORIGIN", status.origin]];
  if (replacing) changes.push(["WEB_ACCESS_TEAM", null], ["WEB_ACCESS_AUD", null]);
  const written = await writeEnv(ctx, changes);
  if (!written.ok) {
    const serveNote = changed.length ? " Die Weiterleitung in Tailscale ist eingerichtet und bleibt." : "";
    return { ok: false, message: `${written.message}${serveNote}`, changed };
  }
  changed.push(...written.changed);

  report({ at: 5, total: TS_TOTAL, label: "Über HTTPS testen" });
  const probe = await httpsProbe(ctx, status.origin, signal);
  const parts = [
    `Eingerichtet. Adresse fürs Handy: ${status.origin}`,
    "Auf dem Handy die Tailscale-App mit demselben Konto anmelden, dann die Adresse im Browser öffnen und mit dem WebUI-Passwort anmelden.",
    probeText(probe, status.origin),
  ];
  if (probe.state !== "ok") parts.push(RESTART_HINT);
  if (replacing) parts.push("Die Cloudflare-Werte sind entfernt; der Tunnel selbst ist unverändert.");
  return { ok: probe.state !== "fehler", message: parts.join(" "), changed };
}

function aborted(changed: string[]): ApplyResult {
  return { ok: false, message: "Abgebrochen. In der .env wurde nichts geändert.", changed };
}

/** Prüfung ohne Änderung: Stand in Tailscale und, wenn eingerichtet, der Test über HTTPS */
async function testTailscale(env: Env, ctx: SetupContext, signal?: AbortSignal): Promise<TestResult> {
  const web = loadWebConfig(env);
  const port = web.status === "ok" ? web.config.port : DEFAULT_WEB_PORT;
  const status = await readTailscaleStatus(ctx, signal);
  if (!status.ok) return { ok: false, message: TAILSCALE_TEXT[status.problem] };
  const items: StatusItem[] = [{ label: "Tailscale", ok: true, detail: "Installiert und angemeldet, MagicDNS und HTTPS-Zertifikate sind an." }];
  const serve = await readServeState(ctx, status.bin, status.host, port, signal);
  if ("problem" in serve) return { ok: false, message: TAILSCALE_TEXT[serve.problem], items };
  const saved = presentValue(env, "WEB_PUBLIC_ORIGIN");
  if (serve.state !== "webui" || saved !== status.origin) {
    const ready = serve.state === "frei" || serve.state === "webui";
    if (!saved && ready) return { ok: true, message: "Tailscale ist bereit. Die Weiterleitung richtet der Ablauf ein.", items };
    if (serve.state === "belegt") return { ok: false, message: TAILSCALE_TEXT.busy, items };
    if (serve.state === "funnel") return { ok: false, message: TAILSCALE_TEXT.funnel, items };
    return { ok: false, message: `Die Weiterleitung in Tailscale oder die Adresse in der .env passt nicht mehr. Neu einrichten mit „${BRAND.cli} setup zugang“.`, items };
  }
  items.push({ label: "Weiterleitung", ok: true, detail: `https://${status.host} zeigt auf die WebUI.` });
  const probe = await httpsProbe(ctx, status.origin, signal);
  items.push({ label: "HTTPS", ok: probe.state !== "fehler", detail: probeText(probe, status.origin) });
  return { ok: probe.state !== "fehler", message: probe.state === "ok" ? "Zugang über Tailscale funktioniert." : probeText(probe, status.origin), items };
}

// ---------------------------------------------------------------------------
// Cloudflare
// ---------------------------------------------------------------------------

/** Adresse, Team und AUD aus den Werten; null, wenn etwas fehlt oder ungültig ist */
function cloudflareValues(merged: SetupValues): { origin: string; team: string; aud: string } | null {
  const origin = merged[ACCESS_DOMAIN_FIELD] ? domainOrigin(merged[ACCESS_DOMAIN_FIELD]) : null;
  const access = parseAccessConfig({ WEB_ACCESS_TEAM: merged.WEB_ACCESS_TEAM, WEB_ACCESS_AUD: merged.WEB_ACCESS_AUD });
  if (!origin || access.status !== "ok" || !access.access) return null;
  return { origin, team: access.access.team, aud: access.access.aud };
}

/**
 * Prüft bei Cloudflare, was sich ohne Anmeldung prüfen lässt: das Team
 * (öffentliche Schlüssel unter <team>.cloudflareaccess.com) und dass Access
 * vor der Adresse liegt (Weiterleitung zur Anmeldung dieses Teams). Die
 * WebUI muss dafür nicht laufen. Den AUD-Wert prüft erst die WebUI selbst,
 * nach der Anmeldung.
 */
async function testCloudflare(cf: { origin: string; team: string }, ctx: SetupContext, signal?: AbortSignal): Promise<TestResult> {
  const items: StatusItem[] = [];
  const teamHost = `${cf.team}.cloudflareaccess.com`;
  try {
    const res = await ctx.fetch(`https://${teamHost}/cdn-cgi/access/certs`, { signal });
    const body = res.ok ? ((await res.json().catch(() => null)) as { keys?: unknown } | null) : null;
    const known = Array.isArray(body?.keys) && body!.keys.length > 0;
    items.push({ label: "Team", ok: known, detail: known ? "Cloudflare kennt das Team." : "Cloudflare kennt diesen Team-Namen nicht. Team domain unter Zero Trust, Settings, Custom Pages prüfen." });
  } catch {
    items.push({ label: "Team", ok: false, detail: "Cloudflare ist gerade nicht erreichbar. Internetverbindung prüfen und erneut testen." });
  }
  try {
    const res = await ctx.fetch(`${cf.origin}${MANIFEST_PATH}`, { signal, redirect: "manual" });
    const location = res.headers.get("location") ?? "";
    let target = "";
    try {
      target = new URL(location, cf.origin).host;
    } catch {
      target = "";
    }
    if (res.status >= 300 && res.status < 400 && target === teamHost) {
      items.push({ label: "Access", ok: true, detail: "Cloudflare Access schützt die Adresse (Anmeldung mit Einmal-Code)." });
    } else if (res.status >= 300 && res.status < 400 && target.endsWith(".cloudflareaccess.com")) {
      items.push({ label: "Access", ok: false, detail: "Die Adresse leitet zur Anmeldung eines anderen Cloudflare-Teams. Team-Name prüfen." });
    } else {
      items.push({
        label: "Access",
        ok: false,
        detail: "Die Adresse ist ohne Cloudflare-Anmeldung erreichbar: erst die Access-Anwendung für diese Domain anlegen (Self-hosted, One-time PIN, Allow nur für die eigene E-Mail).",
      });
    }
  } catch {
    // DNS oder Tunnel noch nicht da: kein Fehler der Werte, Test später nachholen
    items.push({
      label: "Access",
      ok: true,
      detail: `Ausstehend: die Adresse antwortet noch nicht. Tunnel-Eintrag prüfen, später nachholen mit „${BRAND.cli} setup zugang“ oder: curl -sI ${cf.origin}${MANIFEST_PATH} (erwartet: Status 302 zu ${teamHost}).`,
    });
  }
  const failed = items.filter(i => !i.ok);
  return { ok: failed.length === 0, message: failed.length ? failed.map(i => i.detail).join(" ") : "Team und Access passen.", items };
}

async function applyCloudflare(values: SetupValues, ctx: SetupContext): Promise<ApplyResult> {
  const { env, existing, merged } = await mergedValues(values, ctx);
  const problem = invalid(ACCESS_FIELDS, values, existing);
  if (problem) return { ...problem, changed: [] };
  const web = loadWebConfig(env);
  if (web.status === "disabled") return { ok: false, message: ACCESS_NEEDS_WEBUI, changed: [] };
  const before = configuredPath(env);
  if (before === "tailscale" && merged[ACCESS_REPLACE_FIELD] !== "true") return keptBecauseNotConfirmed(before);
  const cf = cloudflareValues(merged);
  if (!cf) return { ok: false, message: "Adresse, Team-Name oder AUD fehlt oder ist ungültig. Nichts wurde geändert.", changed: [] };
  const port = presentValue(env, "WEB_PORT") ?? String(DEFAULT_WEB_PORT);
  const changes: Array<[string, string]> = [
    ["WEB_PUBLIC_ORIGIN", cf.origin],
    ["WEB_ACCESS_TEAM", cf.team],
    ["WEB_ACCESS_AUD", cf.aud],
    ["WEB_PORT", port],
  ];
  // Das Ergebnis muss eine startfähige WebUI sein
  const after = loadWebConfig({ ...env, ...Object.fromEntries(changes) });
  if (after.status !== "ok") return { ok: false, message: `So startet die WebUI nicht: ${after.status === "invalid" ? after.reason : "WebUI ist aus"}. Nichts wurde geändert.`, changed: [] };
  const written = await writeEnv(ctx, changes);
  if (!written.ok) return written;
  const parts = [
    `${written.message} Adresse fürs Handy: ${cf.origin}`,
    `Im Tunnel-Eintrag muss der Service http://localhost:${port} sein, ohne Umschreiben des Host-Headers.`,
    ACCESS_SESSION_HINT,
    RESTART_HINT,
  ];
  if (before === "tailscale") parts.push("Die Weiterleitung in Tailscale bleibt eingerichtet; abschalten mit „tailscale serve --https=443 off“.");
  return { ...written, message: parts.join(" ") };
}

// ---------------------------------------------------------------------------
// Schritt
// ---------------------------------------------------------------------------

export const accessStep: SetupStep = {
  id: "zugang",
  title: "Zugang vom Handy",
  description: "Optional: die WebUI über HTTPS erreichbar machen, damit sie sich aufs Handy legen lässt und Benachrichtigungen schickt.",
  optional: true,
  fields: ACCESS_FIELDS,

  status: accessStatus,

  async test(values, ctx, signal) {
    const { env, existing, merged } = await mergedValues(values, ctx);
    const problem = invalid(ACCESS_FIELDS, values, existing);
    if (problem) return problem;
    if (loadWebConfig(env).status === "disabled") return { ok: false, message: ACCESS_NEEDS_WEBUI };
    const path = (merged[ACCESS_PATH_FIELD] ?? "tailscale") as AccessPath;
    if (path === "tailscale") return testTailscale(env, ctx, signal);
    if (path === "cloudflare") {
      const cf = cloudflareValues(merged);
      if (!cf) return { ok: false, message: "Adresse, Team-Name oder AUD fehlt oder ist ungültig." };
      return testCloudflare(cf, ctx, signal);
    }
    return { ok: true, message: "Nichts zu prüfen: es wird kein Zugang eingerichtet." };
  },

  async apply(values, ctx) {
    const { env, existing, merged } = await mergedValues(values, ctx);
    const problem = invalid(ACCESS_FIELDS, values, existing);
    if (problem) return { ...problem, changed: [] };
    if (merged[ACCESS_PATH_FIELD] === "cloudflare") return applyCloudflare(values, ctx);
    if (merged[ACCESS_PATH_FIELD] === "tailscale") {
      return { ok: false, message: "Tailscale richtet der Ablauf ein („Ausführen“), nicht „Speichern“.", changed: [] };
    }
    const before = currentAccessPath(env);
    const kept = before ? ` Der vorhandene Zugang über ${PATH_TITLE[before]} bleibt unverändert.` : "";
    return { ok: true, message: `${LOCAL_ONLY_TEXT}${kept}`, changed: [] };
  },

  runWhen: isPath("tailscale"),
  run: runTailscale,
  plan(values) {
    if (switching(values) && values[ACCESS_REPLACE_FIELD] !== "true") return ["Nichts ändern: der vorhandene Zugang bleibt, wie er ist."];
    const sentences = [
      "Prüfen, ob Tailscale installiert und angemeldet ist und MagicDNS und HTTPS-Zertifikate an sind. Installiert wird nichts.",
      "Nachsehen, ob Port 443 in Tailscale frei ist. Eine andere Einstellung dort wird nicht überschrieben.",
      "Die Weiterleitung einrichten: tailscale serve --bg --https=443 auf die WebUI dieses Rechners, nur im eigenen Tailnet.",
      "Die Adresse …ts.net als WEB_PUBLIC_ORIGIN in die .env schreiben.",
      `Über HTTPS testen; läuft ${BRAND.name} noch nicht mit der neuen Adresse, bleibt der Test ausstehend.`,
    ];
    if (values.ZUGANG_BISHER === "cloudflare" && values[ACCESS_REPLACE_FIELD] === "true") {
      sentences.splice(4, 0, "WEB_ACCESS_TEAM und WEB_ACCESS_AUD aus der .env entfernen (der Cloudflare-Tunnel selbst bleibt).");
    }
    return sentences;
  },
};
