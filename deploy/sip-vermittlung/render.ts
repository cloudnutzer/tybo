/**
 * Generator der SIP-Vermittlung (Issue #511).
 *
 *   bun render.ts --env .env --aus erzeugt
 *
 * Liest die .env der Vermittlung, prüft jeden Wert und schreibt die
 * Asterisk-Konfiguration aus vorlagen/ nach <aus>/asterisk/ sowie die
 * Firewall-Regeln nach <aus>/firewall.nft. Ersetzt werden nur Platzhalter der
 * Form {{NAME}}; Asterisk-Ausdrücke wie ${EXTEN} bleiben, wie sie sind. Bleibt
 * ein Platzhalter offen oder fehlt ein Wert, scheitert der Lauf und schreibt
 * nichts.
 *
 * Die Datei hängt nur von Bun und node: ab, damit sie auf dem Server allein
 * im Ordner deploy/sip-vermittlung/ läuft (Dienst "vorlagen" in compose.yaml).
 * Werte aus der .env stehen nie in Meldungen, nur ihre Namen.
 */
import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const TEMPLATE_DIR = join(import.meta.dir, "vorlagen");

/** Höchstens so viele Gespräche gleichzeitig, über beide Richtungen (Issue #511) */
export const MAX_CALLS_LIMIT = 2;
/** Je Gespräch zwei Kanäle mit je RTP und RTCP */
export const RTP_PORTS_PER_CALL = 4;
/** Mindestlänge der Passwörter, die der Nutzer selbst wählt */
export const MIN_OWN_PASSWORD = 16;

export type Env = Record<string, string | undefined>;

export interface RelayConfig {
  easybellUser: string;
  easybellPassword: string;
  easybellNumber: string;
  easybellTransport: "tls" | "udp";
  easybellDialFormat: "e164" | "00" | "national";
  easybellHost: string;
  elevenlabsHost: string;
  elevenlabsInUser: string;
  elevenlabsInPassword: string;
  elevenlabsOutUser: string;
  elevenlabsOutPassword: string;
  hostname: string;
  tlsPort: number;
  rtpStart: number;
  rtpEnd: number;
  allowedTargets: string[];
  maxCalls: number;
  maxMinutes: number;
  withheldCaller: "ablehnen" | "annehmen";
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Konfiguration ungültig:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

/** Abschnittsnamen in pjsip.conf, die kein Benutzername sein darf */
export const RESERVED_SECTIONS: readonly string[] = [
  "global", "system", "anonymous", "transport-tls", "transport-udp", "easybell", "easybell-auth", "easybell-reg",
  "elevenlabs", "elevenlabs-ein-auth", "elevenlabs-aus-auth",
];

const E164 =/^\+[1-9][0-9]{6,14}$/;
const USER = /^[A-Za-z0-9._@+-]{1,64}$/;
/** Druckbares ASCII ohne Leerzeichen, ; (Kommentar in .conf), " und \ */
const PASSWORD = /^[!#-:<-[\]-~]{8,128}$/;
const HOST = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/** .env-Text als Schlüssel und Werte; Kommentare, leere Zeilen und Anführungszeichen wie in dotenv */
export function parseEnvText(text: string): Env {
  const env: Env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    env[m[1]] = value;
  }
  return env;
}

/** Nummer in E.164 (+49…); Leerzeichen, Bindestriche und Klammern fallen weg, 00 wird zu + */
export function toE164(raw: string): string | null {
  let n = raw.replace(/[\s\-()/]/g, "");
  if (n.startsWith("00")) n = `+${n.slice(2)}`;
  return E164.test(n) ? n : null;
}

function int(env: Env, name: string, fallback: number, min: number, max: number, problems: string[]): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    problems.push(`${name} muss eine ganze Zahl sein`);
    return fallback;
  }
  const n = Number(raw);
  if (n < min || n > max) problems.push(`${name} muss zwischen ${min} und ${max} liegen`);
  return n;
}

/** Prüft die .env und liefert die Konfiguration; jeder Fehler nennt nur den Namen, nie den Wert */
export function parseConfig(env: Env): RelayConfig {
  const problems: string[] = [];
  const text = (name: string, re: RegExp, what: string, fallback = ""): string => {
    const value = env[name]?.trim() || fallback;
    if (!value) problems.push(`${name} fehlt`);
    else if (!re.test(value)) problems.push(`${name}: ${what}`);
    return value;
  };
  const choice = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const value = (env[name]?.trim() || fallback) as T;
    if (!allowed.includes(value)) problems.push(`${name} muss einer dieser Werte sein: ${allowed.join(", ")}`);
    return value;
  };
  const number = (name: string): string => {
    const raw = env[name]?.trim() ?? "";
    if (!raw) {
      problems.push(`${name} fehlt`);
      return "";
    }
    const n = toE164(raw);
    if (!n) problems.push(`${name} ist keine Rufnummer im Format +49…`);
    return n ?? "";
  };

  const easybellUser = text("EASYBELL_BENUTZER", USER, "nur Buchstaben, Ziffern und ._@+-");
  const easybellPassword = text("EASYBELL_PASSWORT", PASSWORD, "8 bis 128 Zeichen, ohne Leerzeichen, ; \" und \\");
  const easybellNumber = number("EASYBELL_RUFNUMMER");
  const easybellTransport = choice("EASYBELL_TRANSPORT", ["tls", "udp"] as const, "tls");
  const easybellDialFormat = choice("EASYBELL_WAHLFORMAT", ["e164", "00", "national"] as const, "e164");
  const easybellHost = text("EASYBELL_REGISTRAR", HOST, "kein gültiger Rechnername", "voip.easybell.de");
  const elevenlabsHost = text("ELEVENLABS_SIP_ZIEL", HOST, "kein gültiger Rechnername", "sip.rtc.elevenlabs.io");
  const elevenlabsInUser = text("ELEVENLABS_EIN_BENUTZER", USER, "nur Buchstaben, Ziffern und ._@+-");
  const elevenlabsInPassword = text("ELEVENLABS_EIN_PASSWORT", PASSWORD, "8 bis 128 Zeichen, ohne Leerzeichen, ; \" und \\");
  const elevenlabsOutUser = text("ELEVENLABS_AUS_BENUTZER", USER, "nur Buchstaben, Ziffern und ._@+-");
  const elevenlabsOutPassword = text("ELEVENLABS_AUS_PASSWORT", PASSWORD, "8 bis 128 Zeichen, ohne Leerzeichen, ; \" und \\");
  if (elevenlabsOutPassword && elevenlabsOutPassword.length < MIN_OWN_PASSWORD) {
    problems.push(`ELEVENLABS_AUS_PASSWORT muss mindestens ${MIN_OWN_PASSWORD} Zeichen lang sein`);
  }
  if (elevenlabsOutUser && elevenlabsOutUser === easybellUser) problems.push("ELEVENLABS_AUS_BENUTZER darf nicht EASYBELL_BENUTZER sein");
  // Der Benutzername ist zugleich der Name des Endpunkts in pjsip.conf
  if (RESERVED_SECTIONS.includes(elevenlabsOutUser.toLowerCase())) problems.push("ELEVENLABS_AUS_BENUTZER ist ein reservierter Name");
  const hostname = text("SIP_HOSTNAME", HOST, "kein gültiger Rechnername");
  const tlsPort = int(env, "SIP_TLS_PORT", 5061, 1024, 65535, problems);
  const rtpStart = int(env, "RTP_START", 10000, 1024, 65535, problems);
  const rtpEnd = int(env, "RTP_ENDE", 10019, 1024, 65535, problems);
  const maxCalls = int(env, "MAX_GESPRAECHE", MAX_CALLS_LIMIT, 1, MAX_CALLS_LIMIT, problems);
  const maxMinutes = int(env, "MAX_MINUTEN", 10, 1, 60, problems);
  const withheldCaller = choice("UNTERDRUECKTE_NUMMER", ["ablehnen", "annehmen"] as const, "ablehnen");

  if (rtpStart % 2 !== 0) problems.push("RTP_START muss gerade sein");
  if (rtpEnd < rtpStart) problems.push("RTP_ENDE muss größer als RTP_START sein");
  else if (rtpEnd - rtpStart + 1 < RTP_PORTS_PER_CALL * maxCalls) {
    problems.push(`RTP-Bereich zu klein: mindestens ${RTP_PORTS_PER_CALL * maxCalls} Ports für ${maxCalls} Gespräche`);
  }
  if (tlsPort >= rtpStart && tlsPort <= rtpEnd) problems.push("SIP_TLS_PORT liegt im RTP-Bereich");
  if (easybellTransport === "udp" && 5060 >= rtpStart && 5060 <= rtpEnd) problems.push("Port 5060 liegt im RTP-Bereich");

  // Positivliste: ohne eigenen Wert nur USER_PHONE_NUMBER
  const listRaw = env.ERLAUBTE_ZIELE?.trim() || env.USER_PHONE_NUMBER?.trim() || "";
  const allowedTargets: string[] = [];
  if (!listRaw) problems.push("ERLAUBTE_ZIELE und USER_PHONE_NUMBER fehlen: ohne Positivliste wählt die Vermittlung nichts");
  for (const item of listRaw.split(",").map(s => s.trim()).filter(Boolean)) {
    const n = toE164(item);
    if (!n) problems.push("ERLAUBTE_ZIELE enthält einen Eintrag, der keine Rufnummer im Format +49… ist");
    else if (!allowedTargets.includes(n)) allowedTargets.push(n);
  }
  if (allowedTargets.length > 5) problems.push("ERLAUBTE_ZIELE: höchstens 5 Nummern");

  if (problems.length) throw new ConfigError(problems);
  return {
    easybellUser,
    easybellPassword,
    easybellNumber,
    easybellTransport,
    easybellDialFormat,
    easybellHost,
    elevenlabsHost,
    elevenlabsInUser,
    elevenlabsInPassword,
    elevenlabsOutUser,
    elevenlabsOutPassword,
    hostname,
    tlsPort,
    rtpStart,
    rtpEnd,
    allowedTargets,
    maxCalls,
    maxMinutes,
    withheldCaller,
  };
}

/** Dialplan-Zeilen: Ziel gegen die Positivliste, je Nummer ein exakter Vergleich */
function allowlistLines(targets: readonly string[]): string {
  return targets.map(n => ` same => n,GotoIf($["\${ZIEL}" = "${n}"]?erlaubt)`).join("\n");
}

/** Dialplan-Zeile: Ziel im Format, das easybell erwartet */
function dialFormatLine(format: RelayConfig["easybellDialFormat"]): string {
  if (format === "00") return ` same => n,Set(WAHL=00\${ZIEL:1})`;
  if (format === "national") return ` same => n,Set(WAHL=\${IF($["\${ZIEL:0:3}" = "+49"]?0\${ZIEL:3}:00\${ZIEL:1})})`;
  return ` same => n,Set(WAHL=\${ZIEL})`;
}

/**
 * Was mit unterdrückter Nummer auf dem easybell-Weg passiert. Unterdrückt
 * heißt: keine Nummer, keine reine Ziffernfolge oder Anzeige nicht erlaubt
 * (Privacy: id). Bei annehmen geht der Anruf ausschließlich anonym weiter:
 * Nummer und Name werden überschrieben, bevor gewählt wird.
 */
function withheldLines(mode: RelayConfig["withheldCaller"]): string {
  if (mode === "annehmen") {
    return [
      " same => n(unterdrueckt),Log(NOTICE,Eingehend mit unterdrueckter Nummer)",
      " same => n,Set(ANRUFER=anonymous)",
      " same => n,Set(CALLERID(name)=)",
      " same => n,Set(CALLERID(num)=anonymous)",
      " same => n,Goto(weiter)",
    ].join("\n");
  }
  return [
    " same => n(unterdrueckt),Log(NOTICE,Eingehend mit unterdrueckter Nummer abgewiesen)",
    " same => n,Hangup(21)",
  ].join("\n");
}

/**
 * SIP-URI mit Parametern für eine .conf-Datei: Asterisk liest ein
 * ungeschütztes ; als Kommentar und schneidet den Rest ab, deshalb "\;".
 */
export function confUri(uri: string): string {
  return uri.replace(/(?<!\\);/g, "\\;");
}

function udpTransport(cfg: RelayConfig): string {
  if (cfg.easybellTransport !== "udp") return "; easybell über TLS: kein UDP-Port offen";
  return ["[transport-udp]", "type=transport", "protocol=udp", "bind=0.0.0.0:5060"].join("\n");
}

/** Alle Platzhalter mit ihren Werten */
export function placeholders(cfg: RelayConfig): Record<string, string> {
  const tls = cfg.easybellTransport === "tls";
  const maxSeconds = cfg.maxMinutes * 60;
  return {
    EASYBELL_BENUTZER: cfg.easybellUser,
    EASYBELL_PASSWORT: cfg.easybellPassword,
    EASYBELL_RUFNUMMER: cfg.easybellNumber,
    EASYBELL_REGISTRAR: cfg.easybellHost,
    EASYBELL_SERVER_URI: confUri(tls ? `sip:${cfg.easybellHost}:5061;transport=tls` : `sip:${cfg.easybellHost}:5060`),
    ELEVENLABS_URI: confUri(`sip:${cfg.elevenlabsHost}:5061;transport=tls`),
    EASYBELL_TRANSPORT_NAME: tls ? "transport-tls" : "transport-udp",
    EASYBELL_MEDIENSCHUTZ: tls ? "sdes" : "no",
    UDP_TRANSPORT: udpTransport(cfg),
    ELEVENLABS_SIP_ZIEL: cfg.elevenlabsHost,
    ELEVENLABS_EIN_BENUTZER: cfg.elevenlabsInUser,
    ELEVENLABS_EIN_PASSWORT: cfg.elevenlabsInPassword,
    ELEVENLABS_AUS_BENUTZER: cfg.elevenlabsOutUser,
    ELEVENLABS_AUS_PASSWORT: cfg.elevenlabsOutPassword,
    SIP_HOSTNAME: cfg.hostname,
    SIP_TLS_PORT: String(cfg.tlsPort),
    RTP_START: String(cfg.rtpStart),
    RTP_ENDE: String(cfg.rtpEnd),
    MAX_GESPRAECHE: String(cfg.maxCalls),
    MAX_SEKUNDEN: String(maxSeconds),
    // Rückhalt für Klingeln und Aufbau: Kanal endet spätestens 90 s nach der Höchstdauer
    MAX_SEKUNDEN_GESAMT: String(maxSeconds + 90),
    ERLAUBTE_ZIELE_PRUEFUNG: allowlistLines(cfg.allowedTargets),
    WAHLFORMAT: dialFormatLine(cfg.easybellDialFormat),
    UNTERDRUECKT: withheldLines(cfg.withheldCaller),
    UDP_SIP_REGEL: cfg.easybellTransport === "udp" ? "    udp dport 5060 ip saddr @easybell accept\n    udp dport 5060 drop" : "    # easybell über TLS: kein UDP-SIP",
  };
}

const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;

/** Ersetzt genau die bekannten Platzhalter; ein unbekannter oder offener Platzhalter ist ein Fehler */
export function fillTemplate(name: string, template: string, values: Record<string, string>): string {
  const unknown = new Set<string>();
  const out = template.replace(PLACEHOLDER, (match, key: string) => {
    if (!(key in values)) {
      unknown.add(key);
      return match;
    }
    return values[key];
  });
  if (unknown.size) throw new ConfigError([`${name}: unbekannte Platzhalter ${[...unknown].join(", ")}`]);
  if (/\{\{|\}\}/.test(out)) throw new ConfigError([`${name}: offener Platzhalter`]);
  return out;
}

export interface RenderedFile {
  /** Pfad relativ zum Ausgabeordner */
  path: string;
  content: string;
  /** Datei enthält Zugangsdaten */
  secret: boolean;
}

/** Vorlagen mit Endung .vorlage; was in asterisk/ liegt, landet in asterisk/, die übrigen direkt im Ausgabeordner */
export function renderAll(env: Env, templateDir: string = TEMPLATE_DIR): RenderedFile[] {
  const values = placeholders(parseConfig(env));
  const files: RenderedFile[] = [];
  for (const sub of ["asterisk", "."]) {
    const dir = join(templateDir, sub);
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith(".vorlage")) continue;
      const name = entry.slice(0, -".vorlage".length);
      const content = fillTemplate(entry, readFileSync(join(dir, entry), "utf8"), values);
      files.push({ path: sub === "." ? name : `${sub}/${name}`, content, secret: name === "pjsip.conf" });
    }
  }
  return files;
}

export interface WriteOptions {
  /** uid:gid für alle Dateien (nur als root wirksam); Asterisk liest pjsip.conf als dieser Nutzer */
  owner?: { uid: number; gid: number };
  /** Rechte der Datei mit Zugangsdaten; Standard 0640 */
  secretMode?: number;
}

/** Schreibt erst in einen Nachbarordner und tauscht dann aus: ein gescheiterter Lauf hinterlässt den alten Stand */
export function writeRendered(files: readonly RenderedFile[], outDir: string, options: WriteOptions = {}): void {
  const target = resolve(outDir);
  const temp = `${target}.neu`;
  const secretMode = options.secretMode ?? 0o640;
  rmSync(temp, { recursive: true, force: true });
  for (const file of files) {
    const path = join(temp, file.path);
    mkdirSync(dirname(path), { recursive: true });
    const mode = file.secret ? secretMode : 0o644;
    writeFileSync(path, file.content, { mode });
    chmodSync(path, mode);
    if (options.owner) {
      chownSync(path, options.owner.uid, options.owner.gid);
      chownSync(dirname(path), options.owner.uid, options.owner.gid);
    }
  }
  const old = `${target}.alt`;
  rmSync(old, { recursive: true, force: true });
  if (existsSync(target)) renameSync(target, old);
  renameSync(temp, target);
  rmSync(old, { recursive: true, force: true });
}

/** "1000:1000" als uid und gid */
export function parseOwner(raw: string): { uid: number; gid: number } {
  const m = /^([0-9]+):([0-9]+)$/.exec(raw);
  if (!m) throw new ConfigError(["--besitzer erwartet uid:gid, etwa 1000:1000"]);
  return { uid: Number(m[1]), gid: Number(m[2]) };
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const envPath = arg(argv, "--env") ?? join(import.meta.dir, ".env");
  const outDir = arg(argv, "--aus") ?? join(import.meta.dir, "erzeugt");
  const ownerRaw = arg(argv, "--besitzer");
  try {
    const owner = ownerRaw ? parseOwner(ownerRaw) : undefined;
    const files = renderAll(parseEnvText(readFileSync(envPath, "utf8")));
    writeRendered(files, outDir, { owner });
    console.log(`Vorlagen erzeugt: ${files.map(f => f.path).join(", ")}`);
  } catch (err) {
    if (err instanceof ConfigError) console.error(err.message);
    else console.error(`Vorlagen nicht erzeugt: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
