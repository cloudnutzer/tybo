/**
 * Prüfskript der SIP-Vermittlung (Issue #511).
 *
 *   bun run deploy/sip-vermittlung/pruefen.ts              statische Prüfung
 *   bun run deploy/sip-vermittlung/pruefen.ts --container  zusätzlich Laufzeit- und Neustartprüfung mit Docker
 *
 * Statisch: erzeugt die Konfiguration aus beispiel.env und prüft sie ohne
 * Asterisk (keine offenen Platzhalter, nur die Positivliste, Höchstdauer,
 * keine Aufnahme, kein REFER, keine anonymen Wege, geschützte URI-Parameter,
 * keine ungefilterte Logdatei).
 *
 * Container: Asterisk mit dieser Konfiguration (eine Minute Höchstdauer) in
 * zwei internen Docker-Netzen ohne Weg nach außen. Ein zweiter Container
 * spielt easybell (Registrar, Anrufe über die Registrierung) und ElevenLabs
 * (SIP-Trunk mit Digest) mit Zertifikaten einer Prüf-CA
 * (pruefung/sip_probe.py): Registrierung, Gespräche in beide Richtungen,
 * Anrufernummer, Folgeverbindungen zu ElevenLabs (ACK und BYE über neue
 * TLS-Verbindungen zum Contact mit Zertifikat *.hosts.rtc.elevenlabs.io),
 * unterdrückte Nummern (ablehnen und annehmen), dritter Anruf
 * und Parallelstarts, Weiterleitungen, REFER, Höchstdauer. Danach fail2ban mit
 * dem Jail aus fail2ban/ und ein Angreifer, der gesperrt werden muss; dann
 * beide Logwege auf vollständige Rufnummern. Dazu: ohne Firewall-Marke startet
 * Asterisk nicht.
 *
 * Neustart: Debian mit systemd im Container lädt die Firewall über
 * systemd/sip-vermittlung-firewall.service vor einer docker.service-Attrappe.
 *
 * Asterisk läuft im Image aus image/ (Standard-Image mit gepatchtem pjproject),
 * das die Containerprüfung zuerst baut (einmal mit Internet).
 *
 * Braucht Docker; ohne Docker endet --container mit Exit 2 und sagt das.
 * Exit 0 heißt: alle Prüfungen bestanden. Ausgegeben werden nur Beispielwerte.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig, parseEnvText, renderAll, type Env, type RelayConfig, type RenderedFile, writeRendered } from "./render";

export const DIR = import.meta.dir;
export const EXAMPLE_ENV = join(DIR, "beispiel.env");
/** Standard-Image, auf dem image/Dockerfile aufbaut (dort auch für die Prüf-Zertifikate genutzt) */
export const ASTERISK_BASE_IMAGE = "andrius/asterisk:22.11.0_debian-trixie-1b724ca";
/** Aus image/ gebaut: Standard-Image mit pjproject-Patch für TLS-Folgeverbindungen, Tag wie in compose.yaml */
export const ASTERISK_IMAGE = "sip-vermittlung-asterisk:22.11.0-folge1";
export const PROBE_IMAGE = "python:3.13-alpine";
export const FAIL2BAN_IMAGE = "crazymax/fail2ban:1.1.0";
/** Wird aus pruefung/systemd.Dockerfile gebaut (Debian mit festem Digest) */
const SYSTEMD_IMAGE = "sip-vermittlung-systemd-pruefung";

/** Module, die nie geladen werden dürfen: Aufnahme, Weiterleitung, Datensätze, weitere offene Ports */
export const FORBIDDEN_MODULES = [
  "res_pjsip_refer", "app_mixmonitor", "app_record", "app_monitor", "chan_iax2", "pbx_dundi", "chan_unistim",
  "chan_websocket", "res_ari", "res_http_websocket", "res_stasis", "res_hep", "cdr_", "cel_", "res_prometheus",
  "res_pjsip_registrar", "res_pjsip_endpoint_identifier_anonymous",
];

function file(files: readonly RenderedFile[], path: string): string {
  const found = files.find(f => f.path === path);
  if (!found) throw new Error(`${path} fehlt`);
  return found.content;
}

/** Abschnitte einer .conf-Datei: Name und Zeilen (ohne Kommentare; "\;" ist kein Kommentar) */
export function sections(conf: string): { name: string; lines: string[] }[] {
  const out: { name: string; lines: string[] }[] = [];
  for (const raw of conf.split("\n")) {
    const line = raw.replace(/(?<!\\);.*$/, "").trim();
    if (!line) continue;
    const head = /^\[([^\]]+)\]/.exec(line);
    if (head) out.push({ name: head[1], lines: [] });
    else out.at(-1)?.lines.push(line);
  }
  return out;
}

function setting(lines: readonly string[], key: string): string | undefined {
  const found = lines.find(l => new RegExp(`^${key}\\s*=`).test(l));
  return found?.split("=").slice(1).join("=").trim();
}

/** Statische Prüfung der erzeugten Dateien; leer heißt bestanden */
export function staticProblems(files: readonly RenderedFile[], cfg: RelayConfig): string[] {
  const problems: string[] = [];
  for (const f of files) if (/\{\{|\}\}/.test(f.content)) problems.push(`${f.path}: offener Platzhalter`);

  const pjsip = sections(file(files, "asterisk/pjsip.conf"));
  if (pjsip.some(s => s.name.toLowerCase() === "anonymous")) problems.push("pjsip.conf: anonymer Endpunkt");
  if (/alwaysauthreject/i.test(file(files, "asterisk/pjsip.conf"))) problems.push("pjsip.conf: alwaysauthreject ist keine PJSIP-Option");
  const endpoints = pjsip.filter(s => setting(s.lines, "type") === "endpoint");
  if (endpoints.length !== 3) problems.push(`pjsip.conf: ${endpoints.length} Endpunkte statt 3`);
  for (const ep of endpoints) {
    const want: Record<string, string> = { allow_transfer: "no", direct_media: "no", disallow: "all", allow: "alaw", allow_subscribe: "no" };
    for (const [key, value] of Object.entries(want)) {
      if (setting(ep.lines, key) !== value) problems.push(`pjsip.conf [${ep.name}]: ${key} muss ${value} sein`);
    }
    const identify = setting(ep.lines, "identify_by");
    if (!identify) problems.push(`pjsip.conf [${ep.name}]: identify_by fehlt`);
    else if (identify.split(",").some(m => m.trim() === "username")) problems.push(`pjsip.conf [${ep.name}]: Zuordnung über den From-Benutzernamen ist fälschbar`);
  }
  const fromElevenlabs = endpoints.find(e => setting(e.lines, "context") === "von-elevenlabs");
  if (!fromElevenlabs) problems.push("pjsip.conf: kein Endpunkt für den Kontext von-elevenlabs");
  else {
    if (!setting(fromElevenlabs.lines, "auth")) problems.push("pjsip.conf: Weg von ElevenLabs ohne Digest-Anmeldung");
    if (setting(fromElevenlabs.lines, "identify_by") !== "auth_username") problems.push("pjsip.conf: Weg von ElevenLabs muss über auth_username zugeordnet werden");
  }
  for (const ep of endpoints) {
    if (setting(ep.lines, "context") !== "von-elevenlabs" && pjsip.some(s => s.name === ep.name && setting(s.lines, "type") === "identify")) {
      problems.push(`pjsip.conf [${ep.name}]: Zuordnung über Adressen nicht vorgesehen`);
    }
  }
  // Folgeverbindungen zu ElevenLabs gehen an <ip>.hosts.rtc.elevenlabs.io mit Zertifikat *.hosts.rtc.elevenlabs.io
  const tls = pjsip.find(s => s.name === "transport-tls")?.lines ?? [];
  if (setting(tls, "verify_server") !== "yes") problems.push("pjsip.conf [transport-tls]: verify_server muss yes sein");
  if (setting(tls, "allow_wildcard_certs") !== "yes") problems.push("pjsip.conf [transport-tls]: allow_wildcard_certs fehlt (Wildcard-Zertifikate von ElevenLabs)");

  const modules = sections(file(files, "asterisk/modules.conf")).find(s => s.name === "modules");
  if (setting(modules?.lines ?? [], "autoload") !== "no") problems.push("modules.conf: autoload muss no sein");
  const loaded = (modules?.lines ?? []).filter(l => l.startsWith("load")).map(l => l.split("=>")[1].trim());
  for (const bad of FORBIDDEN_MODULES) {
    if (loaded.some(m => m.startsWith(bad))) problems.push(`modules.conf: ${bad} darf nicht geladen werden`);
  }

  const ext = file(files, "asterisk/extensions.conf");
  const allowLines = ext.split("\n").filter(l => /GotoIf\(\$\["\$\{ZIEL\}" = "/.test(l));
  const listed = allowLines.map(l => /= "(\+[0-9]+)"/.exec(l)?.[1]);
  if (JSON.stringify(listed) !== JSON.stringify(cfg.allowedTargets)) problems.push("extensions.conf: Positivliste weicht von der Konfiguration ab");
  const dials = ext.split("\n").filter(l => /\bDial\(/.test(l));
  if (dials.length !== 2) problems.push(`extensions.conf: ${dials.length} Dial-Zeilen statt 2`);
  for (const d of dials) if (!d.includes(`S(${cfg.maxMinutes * 60})`)) problems.push("extensions.conf: Dial ohne Höchstdauer");
  for (const d of dials) if (!/[,)]iS\(/.test(d)) problems.push("extensions.conf: Dial folgt Umleitungen (Option i fehlt)");
  if (!dials.some(d => d.includes("PJSIP/${WAHL}@easybell"))) problems.push("extensions.conf: ausgehend wählt nicht über easybell");
  if (!/Gosub\(gespraeche-zaehlen/.test(ext) || (ext.match(/Gosub\(gespraeche-zaehlen/g) ?? []).length !== 2) {
    problems.push("extensions.conf: Gesprächszähler fehlt in einer Richtung");
  }
  if (/\b(Verbose|NoOp)\(/.test(ext)) problems.push("extensions.conf: Verbose/NoOp schrieben ungekürzte Werte");
  for (const line of ext.split("\n").filter(l => /\bLog\(/.test(l))) {
    if (/\$\{(ANRUFER|ZIEL|ROH|EXTEN|WAHL|CALLERID\(num\))\}/.test(line)) problems.push("extensions.conf: Log mit ungekürzter Rufnummer");
  }
  const pattern = /^exten => ([^,]+),/gm;
  for (const m of ext.matchAll(pattern)) if (m[1] === "_." || m[1] === "_!") problems.push("extensions.conf: Muster _. oder _! trifft auch Sonder-Extensions");

  // Asterisk liest ein ungeschütztes ; als Kommentar: ein URI-Parameter dahinter fiele weg
  for (const f of files.filter(f => f.path.startsWith("asterisk/"))) {
    for (const raw of f.content.split("\n")) {
      if (/^[^;]*=[^;]*(?<!\\);[a-z_]+=/i.test(raw)) problems.push(`${f.path}: ungeschütztes ; vor einem Parameter (Asterisk schneidet ab): ${raw.split("=")[0].trim()}`);
    }
  }
  const tlsTargets = (file(files, "asterisk/pjsip.conf").match(/\\;transport=tls$/gm) ?? []).length;
  if (tlsTargets !== (cfg.easybellTransport === "tls" ? 3 : 1)) problems.push("pjsip.conf: TLS-Ziele ohne geschütztes \\;transport=tls");

  // Asterisk schreibt nur auf die Konsole; container/logfilter.pl kürzt Rufnummern, bevor etwas gespeichert wird
  const logger = sections(file(files, "asterisk/logger.conf")).find(s => s.name === "logfiles")?.lines ?? [];
  if (logger.some(l => /\b(verbose|debug|dtmf)\b/.test(l))) problems.push("logger.conf: verbose, debug oder dtmf im Log");
  if (logger.some(l => !/^console\s*=>/.test(l))) problems.push("logger.conf: Asterisk darf nur auf die Konsole schreiben, nicht ungefiltert in eine Datei");
  for (const name of ["cdr.conf", "cel.conf"]) {
    if (!/^enable\s*=\s*no$/m.test(file(files, `asterisk/${name}`))) problems.push(`${name}: muss abgeschaltet sein`);
  }
  if (!/^enabled\s*=\s*no$/m.test(file(files, "asterisk/manager.conf"))) problems.push("manager.conf: muss abgeschaltet sein");
  if (!/^enabled\s*=\s*no$/m.test(file(files, "asterisk/http.conf"))) problems.push("http.conf: muss abgeschaltet sein");
  const rtp = sections(file(files, "asterisk/rtp.conf"))[0]?.lines ?? [];
  if (setting(rtp, "strictrtp") !== "yes") problems.push("rtp.conf: strictrtp muss yes sein");
  if (setting(rtp, "rtpstart") !== String(cfg.rtpStart) || setting(rtp, "rtpend") !== String(cfg.rtpEnd)) problems.push("rtp.conf: Portbereich weicht ab");
  return problems;
}

// ---------------------------------------------------------------------------
// Container: Laufzeitprüfung mit SIP-Gegenstellen
// ---------------------------------------------------------------------------

function docker(args: string[], timeoutMs = 120_000): { code: number; out: string } {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: timeoutMs });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Eine Zeile JSON aus pruefung/sip_probe.py */
export interface ProbeResult {
  probe: string;
  [key: string]: unknown;
}

/** Werte der Laufzeitprüfung, die nicht aus der Konfiguration kommen */
export interface RuntimeValues {
  /** Nummer des Anrufers bei easybell (erfunden) */
  caller: string;
  /** Ziel außerhalb der Positivliste */
  forbidden: string;
  /** Nummer, mit der sich der Angreifer anzumelden versucht */
  attacker: string;
}

export const RUNTIME: RuntimeValues = { caller: "+4917612345678", forbidden: "+4915550199999", attacker: "+4917699887766" };

/** Umgebung der Laufzeitprüfung: Beispiel-.env mit einer Minute Höchstdauer, damit das Gesprächsende messbar ist */
export function runtimeEnv(env: Env, phase: "a" | "b"): Env {
  return { ...env, MAX_MINUTEN: "1", UNTERDRUECKTE_NUMMER: phase === "a" ? "ablehnen" : "annehmen" };
}

const isReject = (s: unknown) => typeof s === "number" && s >= 400;

/**
 * Bewertet die Proben einer Phase; leer heißt bestanden.
 * Phase a: Standard (unterdrückte Nummern ablehnen), Phase b: annehmen.
 */
export function runtimeProblems(results: readonly ProbeResult[], cfg: RelayConfig, values: RuntimeValues, phase: "a" | "b"): string[] {
  const problems: string[] = [];
  const expect = (name: string, ok: (r: ProbeResult) => boolean, what: string) => {
    const r = results.find(x => x.probe === name);
    if (!r || !ok(r)) problems.push(`${name}: ${what} (erhalten: ${JSON.stringify(r ?? null)})`);
  };
  const { caller, forbidden } = values;
  const allowed = cfg.allowedTargets[0];

  expect("registrierung", r => r.registriert === true, "die Vermittlung muss sich beim Registrar anmelden");
  expect("registrierung", r => r.kontakt_tls === true && r.via_tls === true && String(r.register_an).includes("transport=tls"),
    "REGISTER über TLS mit transport=tls im Contact (sonst stellt der Registrar über UDP zu)");
  expect("registrierung", r => r.kontakt_line === true, "Contact der Registrierung ohne line=");

  if (phase === "b") {
    expect("annehmen_unterdrueckt_privacy_id", r => r.status === 200 && r.x_caller_id === "anonymous" && r.nummer_bei_elevenlabs === false && r.elevenlabs_invites === 1,
      "Nummer mit Privacy: id geht nur anonym weiter, ohne Nummer in irgendeiner Kopfzeile");
    expect("annehmen_unterdrueckt_anonym", r => r.status === 200 && r.x_caller_id === "anonymous", "unterdrückte Nummer geht als anonymous weiter");
    expect("annehmen_sichtbar", r => r.status === 200 && r.x_caller_id === caller, "sichtbare Nummer geht weiter mit");
    return problems;
  }

  expect("ohne_anmeldung_als_easybell", r => r.status === 401, "ohne Anmeldung muss 401 kommen");
  expect("ohne_anmeldung_als_elevenlabs", r => r.status === 401, "ohne Anmeldung muss 401 kommen");
  expect("falsches_passwort", r => r.erste === 401 && (r.status === 401 || r.status === 403), "falsches Passwort muss abgewiesen werden");
  expect("unbekannter_benutzer", r => r.erste === 401 && (r.status === 401 || r.status === 403), "unbekanntes Konto muss abgewiesen werden");
  expect("verbotenes_ziel", r => r.erste === 401 && r.status === 403 && r.easybell_invites === 0, "nicht erlaubtes Ziel endet nach der Anmeldung mit 403, ohne Anruf bei easybell");
  expect("buchstaben_als_ziel", r => r.erste === 401 && (r.status === 403 || r.status === 404), "ungültiges Ziel muss abgewiesen werden");
  expect("eingehend_ohne_line", r => r.status === 401 && r.elevenlabs_invites === 0, "ohne line= der Registrierung ist ein Anruf nicht easybell");
  expect("eingehend_falsche_line", r => r.status === 401 && r.elevenlabs_invites === 0, "mit falschem line= ist ein Anruf nicht easybell");

  expect("eingehend", r => r.status === 200 && r.elevenlabs_invites === 1 && r.ruri_user === cfg.easybellNumber,
    "eingehender Anruf über die Registrierung wird bei ElevenLabs angenommen (an die eigene Nummer)");
  expect("eingehend", r => r.x_caller_id === caller && r.from_user === caller && String(r.pai).includes(caller),
    "Anrufernummer kommt als X-Caller-ID, From und P-Asserted-Identity bei ElevenLabs an");
  expect("eingehend", r => r.bye === 200 && r.gegenseite_beendet === true, "Auflegen beendet auch das Gespräch bei ElevenLabs");
  expect("eingehend_national", r => r.status === 200 && r.x_caller_id === caller, "nationale Schreibweise kommt als +49… an");
  expect("ausgehend", r => r.erste === 401 && r.status === 200 && r.easybell_invites === 1 && r.ruri_user === allowed && r.from_user === cfg.easybellUser,
    "/anruf zum erlaubten Ziel wird nach Anmeldung bei easybell angenommen");
  expect("ausgehend", r => r.bye === 200 && r.gegenseite_beendet === true, "Auflegen beendet auch das Gespräch bei easybell");
  expect("ausgehend_national", r => r.status === 200 && r.ruri_user === allowed, "erlaubtes Ziel in nationaler Schreibweise wird gewählt");
  // Folgeverbindungen (README, „Folgeverbindungen“): Der Contact <ip>.hosts.rtc.elevenlabs.io zeigt
  // *.hosts.rtc.elevenlabs.io. ACK und BYE müssen über neue Verbindungen dorthin ankommen, SNI und
  // Namensprüfung gelten dem Contact-Namen. Jeder andere Name am Contact wird abgelehnt.
  expect("folgeverbindung_wildcard", r => r.aufgebaut === true && r.ack_ueber_folgeverbindung === true && r.alte_verbindungen_zu === true
    && r.bye === 200 && r.bye_angekommen === true && r.bye_ueber_neue_verbindung === true && JSON.stringify(r.sni) === JSON.stringify([FOLLOW_HOST]),
    `Zertifikat *.hosts.rtc.elevenlabs.io am Contact: ACK und BYE kommen über neue TLS-Verbindungen mit SNI ${FOLLOW_HOST} an`);
  for (const name of ["folgeverbindung_falscher_name", "folgeverbindung_erster_name"]) {
    expect(name, r => r.aufgebaut === true && r.alte_verbindungen_zu === true && typeof r.verbindungsversuche === "number" && r.verbindungsversuche >= 1
      && r.anfragen === 0 && r.bye_angekommen === false && r.ack_ueber_folgeverbindung === false,
      "Zertifikat ohne den Namen des Contacts: Asterisk baut die Verbindung ab und schickt nichts darüber");
  }
  // Gegenprobe zum Patch: Ein Contact als IP-Adresse hat keinen eigenen Namen, dann gilt der der ersten Verbindung
  expect("folgeverbindung_ip_adresse", r => r.aufgebaut === true && r.ack_ueber_folgeverbindung === true && r.bye_angekommen === true
    && r.bye_ueber_neue_verbindung === true && JSON.stringify(r.sni) === JSON.stringify(["sip.rtc.elevenlabs.io"]),
    "Contact als IP-Adresse: ACK und BYE gehen mit dem Namen der ersten Verbindung (sip.rtc.elevenlabs.io)");

  expect("unterdrueckt_privacy_id", r => isReject(r.status) && r.elevenlabs_invites === 0, "Nummer mit Privacy: id wird standardmäßig abgelehnt");
  expect("unterdrueckt_anonym", r => isReject(r.status) && r.elevenlabs_invites === 0, "unterdrückte Nummer wird standardmäßig abgelehnt");

  expect("dritter_anruf", r => JSON.stringify(r.erste_beiden) === "[true,true]" && isReject(r.dritter_eingehend) && isReject(r.dritter_ausgehend) && r.neue_invites === 0,
    `der dritte gleichzeitige Anruf wird abgewiesen (Grenze ${cfg.maxCalls})`);
  for (const name of ["parallelstart_gemischt", "parallelstart_ausgehend", "parallelstart_eingehend"]) {
    expect(name, r => typeof r.aufgebaut === "number" && r.aufgebaut <= cfg.maxCalls && Array.isArray(r.codes) && r.codes.every(c => typeof c === "number"),
      `bei drei gleichzeitigen Starts höchstens ${cfg.maxCalls} Gespräche`);
  }
  expect("frei_nach_parallelstart", r => r.status === 200, "nach dem Auflegen ist der Zähler wieder frei");

  expect("weiterleitung_eingehend", r => r.status !== 200 && JSON.stringify(r.easybell_ziele) === "[]", "eine Umleitung (302) von ElevenLabs führt zu keinem Anruf");
  expect("weiterleitung_ausgehend", r => r.status !== 200 && JSON.stringify(r.easybell_ziele) === JSON.stringify([allowed]) && r.elevenlabs_invites === 0,
    "eine Umleitung (302) von easybell führt zu keinem weiteren Anruf");
  // Ohne res_pjsip_refer beantwortet Asterisk REFER nicht: kein 202, keine Weitergabe, das Gespräch bleibt bis zum Auflegen
  for (const name of ["refer_von_elevenlabs_eingehend", "refer_von_easybell_eingehend", "refer_von_elevenlabs_ausgehend", "refer_von_easybell_ausgehend"]) {
    expect(name, r => r.aufgebaut === true && (r.refer === null || isReject(r.refer)) && r.neue_invites === 0 && r.bye === 200,
      `REFER an ${forbidden.slice(0, 6)}... wird nicht angenommen, wählt nichts und das Gespräch endet erst beim Auflegen`);
  }

  const limit = cfg.maxMinutes * 60;
  expect("hoechstdauer", r => {
    const legs = ["eingehend_easybell", "eingehend_elevenlabs", "ausgehend_elevenlabs", "ausgehend_easybell"].map(k => r[k]);
    return r.grenze === limit && legs.every(d => typeof d === "number" && d >= limit - 1 && d <= limit + 20) && JSON.stringify(r.beendet_durch) === '["vermittlung"]';
  }, `die Vermittlung beendet beide Richtungen nach ${limit} s`);
  return problems;
}

/** Vollständige Nummern (mit und ohne +, national) dürfen weder in logs/messages noch im Docker-Log stehen */
export function logProblems(logs: string, numbers: readonly string[]): string[] {
  const problems: string[] = [];
  for (const n of numbers) {
    const forms = [n, n.slice(1), n.startsWith("+49") ? `0${n.slice(3)}` : n.slice(1)];
    if (forms.some(f => logs.includes(f))) problems.push(`Log enthält eine ungekürzte Rufnummer (${n.slice(0, 6)}...)`);
  }
  const missing = logs.split("\n").filter(l => /No application '|Function .* not registered|Unable to load module|Declined to load/.test(l));
  if (missing.length) problems.push(`Log: fehlende Anwendung oder Funktion im Wählplan: ${missing[0].replace(/^.*?(No application|Function|Unable|Declined)/, "$1").slice(0, 120)}`);
  if (!logs.includes("Ausgehend abgewiesen: Ziel")) problems.push("Log: Abweisung des verbotenen Ziels fehlt");
  if (!/SecurityEvent="(InvalidAccountID|ChallengeResponseFailed)"[^\n]*RemoteAddress="IPV4\/TLS\/\d+\.\d+\.\d+\.\d+\/\d+"/.test(logs)) {
    problems.push("Log: Sicherheitsereignis mit Absenderadresse für fail2ban fehlt");
  }
  return problems;
}

/** fail2ban: Filter trifft, die Adresse des Angreifers ist gesperrt und erreicht die Vermittlung nicht mehr */
export function fail2banProblems(attack: ProbeResult | undefined, status: string, regexOut: string): string[] {
  const problems: string[] = [];
  const matched = Number(/Lines: \d+ lines, \d+ ignored, (\d+) matched/.exec(regexOut)?.[1] ?? 0);
  if (matched < 6) problems.push(`fail2ban-Filter trifft ${matched} Zeilen, erwartet mindestens 6`);
  if (!attack || typeof attack.ip !== "string") return [...problems, "Angriffsprobe ohne Ergebnis"];
  // Ein Versuch ohne Antwort am Ende heißt: Die Sperre griff mitten im Versuch
  const codes = Array.isArray(attack.codes) ? [...attack.codes] : [];
  while (codes.length && codes.at(-1) === null) codes.pop();
  if (codes.length < 2) problems.push("Angreifer war schon vor seinen Versuchen gesperrt oder nicht erreichbar");
  if (!/Banned IP list:.*/.test(status) || !status.split("\n").some(l => l.includes("Banned IP list") && l.split(/\s+/).includes(attack.ip as string))) {
    problems.push("fail2ban hat die Adresse des Angreifers nicht gesperrt");
  }
  if (attack.gesperrt !== true) problems.push("die gesperrte Adresse erreicht die Vermittlung weiterhin");
  if (!codes.every(c => c === 401 || c === 403)) problems.push("Anmeldeversuche des Angreifers wurden nicht abgewiesen");
  return problems;
}

/** Neustart-Nachweis: Zeilen aus der docker.service-Attrappe, je Systemstart eine */
export function bootProblems(lines: readonly string[]): string[] {
  const want = ["tabelle=ja marke=ja", "tabelle=nein marke=nein", "tabelle=ja marke=ja"];
  if (JSON.stringify(lines) === JSON.stringify(want)) return [];
  return [`Neustart: Firewall vor Docker erwartet ${JSON.stringify(want)}, erhalten ${JSON.stringify(lines)}`];
}

const NAMES = {
  asterisk: "sipv-pruefung-asterisk",
  peers: "sipv-pruefung-gegenstellen",
  attacker: "sipv-pruefung-angreifer",
  fail2ban: "sipv-pruefung-fail2ban",
  systemd: "sipv-pruefung-systemd",
  netEasybell: "sipv-pruefung-easybell",
  netElevenlabs: "sipv-pruefung-elevenlabs",
};
/** Feste Netze, damit der Angreifer eine eigene Adresse hat (die Gegenstellen sammeln bei den Anmeldeproben selbst Fehlversuche) */
const SUBNETS = { [NAMES.netEasybell]: "10.231.11.0/24", [NAMES.netElevenlabs]: "10.231.12.0/24" };
const ATTACKER_IP = "10.231.12.200";
/** Adresse der ElevenLabs-Attrappe und ihr Name für Folgeverbindungen, wie bei ElevenLabs <ip>.hosts.rtc.elevenlabs.io */
const PEER_IP_ELEVENLABS = "10.231.12.10";
export const FOLLOW_HOST = `${PEER_IP_ELEVENLABS.replaceAll(".", "-")}.hosts.rtc.elevenlabs.io`;

function cleanup(): void {
  docker(["rm", "-f", NAMES.asterisk, NAMES.peers, NAMES.attacker, NAMES.fail2ban, NAMES.systemd], 60_000);
  docker(["network", "rm", NAMES.netEasybell, NAMES.netElevenlabs], 30_000);
}

function probeConfig(cfg: RelayConfig): string {
  return JSON.stringify({
    asterisk_host: cfg.hostname, port: cfg.tlsPort,
    easybell_user: cfg.easybellUser, easybell_pass: cfg.easybellPassword, easybell_nummer: cfg.easybellNumber,
    el_in_user: cfg.elevenlabsInUser, el_in_pass: cfg.elevenlabsInPassword,
    el_out_user: cfg.elevenlabsOutUser, el_out_pass: cfg.elevenlabsOutPassword,
    erlaubt: cfg.allowedTargets[0], verboten: RUNTIME.forbidden, anrufer: RUNTIME.caller, angreifer_nummer: RUNTIME.attacker,
    max_sekunden: cfg.maxMinutes * 60, versuche: 6, folge_host: FOLLOW_HOST, folge_ip: PEER_IP_ELEVENLABS,
    // Fehlersuche: nur einzelne Gruppen, SIP-Startzeilen auf stderr
    nur: process.env.SIP_PRUEFUNG_NUR?.split(",").filter(Boolean), protokoll: Boolean(process.env.SIP_PRUEFUNG_PROTOKOLL),
  });
}

function parseProbes(out: string): ProbeResult[] {
  return out.split("\n").filter(l => l.startsWith("{")).map(l => JSON.parse(l) as ProbeResult);
}

/** Gegenstellen (easybell und ElevenLabs) als ein Container mit zwei Adressen, je Netz eine */
function startPeers(workDir: string, mode: string, cfg: RelayConfig): string | null {
  docker(["rm", "-f", NAMES.peers], 30_000);
  const create = docker(["create", "--name", NAMES.peers, "--network", NAMES.netEasybell, "--network-alias", "voip.easybell.de",
    "-v", `${join(DIR, "pruefung")}:/probe:ro`, "-v", `${join(workDir, "pki")}:/pki:ro`,
    PROBE_IMAGE, "python", "-I", "-u", "/probe/sip_probe.py", mode, probeConfig(cfg)]);
  if (create.code !== 0) return `Gegenstellen nicht angelegt: ${create.out.slice(0, 300)}`;
  const connect = docker(["network", "connect", "--ip", PEER_IP_ELEVENLABS, "--alias", "sip.rtc.elevenlabs.io", "--alias", FOLLOW_HOST, NAMES.netElevenlabs, NAMES.peers]);
  if (connect.code !== 0) return `Gegenstellen nicht verbunden: ${connect.out.slice(0, 300)}`;
  return docker(["start", NAMES.peers]).code === 0 ? null : "Gegenstellen starten nicht";
}

function waitPeers(timeoutMs: number): ProbeResult[] {
  docker(["wait", NAMES.peers], timeoutMs);
  const out = docker(["logs", NAMES.peers]).out;
  if (process.env.SIP_PRUEFUNG_PROTOKOLL) console.error(out.split("\n").filter(l => l.startsWith("#")).join("\n"));
  return parseProbes(out);
}

function renderTo(env: Env, workDir: string): void {
  writeRendered(renderAll(env), join(workDir, "erzeugt"), { secretMode: 0o644 });
}

function asteriskArgs(workDir: string, marker: string): string[] {
  return [
    "-v", `${join(workDir, "erzeugt", "asterisk")}:/etc/asterisk:ro`,
    "-v", `${join(workDir, "pki", "asterisk")}:/zertifikat:ro`,
    // Prüf-CA statt der öffentlichen: die Gegenstellen zeigen Zertifikate dieser CA
    "-v", `${join(workDir, "pki", "ca.pem")}:/etc/ssl/certs/ca-certificates.crt:ro`,
    "-v", `${join(DIR, "container")}:/vermittlung:ro`,
    "-v", `${join(workDir, "logs")}:/var/log/asterisk`,
    "-v", `${marker}:/firewall:ro`,
    "-e", "TZ=UTC",
    ASTERISK_IMAGE, "/bin/sh", "/vermittlung/start.sh",
  ];
}

function waitAsterisk(): boolean {
  for (let i = 0; i < 40; i++) {
    if (docker(["exec", NAMES.asterisk, "asterisk", "-rx", "core show uptime"], 10_000).out.includes("uptime")) return true;
    spawnSync("sleep", ["1"]);
  }
  return false;
}

/** Ohne Marke der Firewall startet Asterisk nicht */
function startLockProblems(workDir: string): string[] {
  const empty = join(workDir, "marke-leer");
  mkdirSync(empty, { recursive: true });
  docker(["rm", "-f", NAMES.asterisk], 30_000);
  const run = docker(["run", "-d", "--name", NAMES.asterisk, "--network", "none", ...asteriskArgs(workDir, empty)], 300_000);
  if (run.code !== 0) return [`Container startet nicht: ${run.out.slice(0, 300)}`];
  const exit = docker(["wait", NAMES.asterisk], 60_000).out.trim();
  const logs = docker(["logs", NAMES.asterisk]).out;
  docker(["rm", "-f", NAMES.asterisk], 30_000);
  console.log(`  Start ohne Firewall-Marke: Exit ${exit}`);
  if (exit === "0" || !logs.includes("Firewall der Vermittlung seit dem Systemstart nicht geladen")) {
    return ["Asterisk startet ohne geladene Firewall"];
  }
  return [];
}

/** Startet Asterisk mit Gegenstellen, schickt alle Proben, prüft Logs und fail2ban, räumt auf */
export function runContainerCheck(env: Env, workDir: string): string[] {
  if (docker(["info", "--format", "{{.ServerVersion}}"], 15_000).code !== 0) {
    console.error("Docker ist nicht erreichbar: die Containerprüfung braucht einen laufenden Docker-Dienst.");
    process.exit(2);
  }
  const envA = runtimeEnv(env, "a");
  const cfgA = parseConfig(envA);
  rmSync(workDir, { recursive: true, force: true });
  for (const sub of ["pki", "logs", "marke"]) mkdirSync(join(workDir, sub), { recursive: true });
  writeFileSync(join(workDir, "marke", "geladen"), "pruefung\n");
  cleanup();
  const problems: string[] = [];
  try {
    const build = docker(["build", "-q", "-t", ASTERISK_IMAGE, join(DIR, "image")], 900_000);
    if (build.code !== 0) return [`Asterisk-Image aus image/ nicht gebaut: ${build.out.slice(-400)}`];
    const pki = docker(["run", "--rm", "--network", "none", "--entrypoint", "sh", "-v", `${join(workDir, "pki")}:/pki`, "-v", `${join(DIR, "pruefung")}:/probe:ro`,
      ASTERISK_BASE_IMAGE, "/probe/pki.sh", cfgA.hostname], 120_000);
    if (pki.code !== 0) return [`Prüf-Zertifikate nicht erzeugt: ${pki.out.slice(0, 300)}`];
    renderTo(envA, workDir);
    problems.push(...startLockProblems(workDir));

    for (const net of [NAMES.netEasybell, NAMES.netElevenlabs]) {
      const r = docker(["network", "create", "--internal", "--subnet", SUBNETS[net], net]);
      if (r.code !== 0) return [`Netz ${net} nicht angelegt: ${r.out.slice(0, 200)}`];
    }
    const peerError = startPeers(workDir, "phase-a", cfgA);
    if (peerError) return [peerError];
    const create = docker(["create", "--name", NAMES.asterisk, "--network", NAMES.netEasybell, ...asteriskArgs(workDir, join(workDir, "marke"))]);
    if (create.code !== 0) return [`Asterisk nicht angelegt: ${create.out.slice(0, 300)}`];
    docker(["network", "connect", "--alias", cfgA.hostname, NAMES.netElevenlabs, NAMES.asterisk]);
    docker(["start", NAMES.asterisk]);
    if (!waitAsterisk()) return [`Asterisk startet nicht: ${docker(["logs", NAMES.asterisk]).out.slice(-600)}`];

    // Konfiguration so, wie Asterisk sie geladen hat
    const show = (cmd: string) => docker(["exec", NAMES.asterisk, "asterisk", "-rx", cmd], 15_000).out;
    const dialplan = show("dialplan show");
    for (const ctx of ["von-easybell", "eingang-pruefen", "von-elevenlabs", "ausgang-pruefen", "gespraeche-zaehlen", "gesperrt"]) {
      if (!dialplan.includes(`Context '${ctx}'`)) problems.push(`Wählplan: Kontext ${ctx} fehlt`);
    }
    const endpoints = show("pjsip show endpoints");
    for (const ep of ["easybell", "elevenlabs", cfgA.elevenlabsOutUser]) {
      if (!new RegExp(`Endpoint:\\s+${ep.replace(/[.+]/g, "\\$&")}\\s`).test(endpoints)) problems.push(`Endpunkt ${ep} fehlt`);
    }
    const aorEl = show("pjsip show aor elevenlabs");
    const aorEb = show("pjsip show aor easybell");
    const reg = show("pjsip show registration easybell-reg");
    console.log(`  Geladen: ${/contact\s+:\s+(\S+)/.exec(aorEl)?.[1]}, ${/contact\s+:\s+(\S+)/.exec(aorEb)?.[1]}, ${/server_uri\s+:\s+(\S+)/.exec(reg)?.[1]}`);
    if (!/contact\s+:\s+sip:\S+;transport=tls/.test(aorEl)) problems.push("ElevenLabs-Ziel ohne transport=tls geladen");
    if (cfgA.easybellTransport === "tls" && !/contact\s+:\s+sip:\S+;transport=tls/.test(aorEb)) problems.push("easybell-Ziel ohne transport=tls geladen");
    if (cfgA.easybellTransport === "tls" && !/server_uri\s+:\s+sip:\S+;transport=tls/.test(reg)) problems.push("Registrierung ohne transport=tls geladen");
    if (!/0 modules loaded/.test(show("module show like refer"))) problems.push("REFER-Modul ist geladen");
    if (!/0 modules loaded/.test(show("module show like mixmonitor"))) problems.push("Aufnahme-Modul ist geladen");

    // Phase a: alle Proben mit der Standardkonfiguration (eine Minute Höchstdauer)
    let registered = false;
    for (let i = 0; i < 60 && !registered; i++) {
      registered = /easybell-reg\/\S+\s+easybell-auth\s+Registered/.test(show("pjsip show registrations"));
      if (!registered) spawnSync("sleep", ["1"]);
    }
    if (!registered) problems.push("Registrierung bei der Gegenstelle nicht im Zustand Registered");
    const resultsA = waitPeers(420_000);
    const ports = parseProbes(docker(["run", "--rm", "--network", `container:${NAMES.asterisk}`, "-v", `${join(DIR, "pruefung")}:/probe:ro`, PROBE_IMAGE,
      "python", "-I", "/probe/sip_probe.py", "ports"]).out).find(r => r.probe === "ports");
    if (JSON.stringify(ports?.tcp) !== JSON.stringify([cfgA.tlsPort])) problems.push(`offene TCP-Ports: ${JSON.stringify(ports?.tcp)} statt [${cfgA.tlsPort}]`);
    const badUdp = ((ports?.udp as number[] | undefined) ?? []).filter(p => p < 32768 && !(p >= cfgA.rtpStart && p <= cfgA.rtpEnd));
    if (badUdp.length) problems.push(`offene UDP-Ports außerhalb RTP: ${badUdp.join(", ")}`);
    problems.push(...runtimeProblems(resultsA, cfgA, RUNTIME, "a"));

    // Phase b: unterdrückte Nummern annehmen, nur anonym weiter
    const envB = runtimeEnv(env, "b");
    const cfgB = parseConfig(envB);
    renderTo(envB, workDir);
    const peerErrorB = startPeers(workDir, "phase-b", cfgB);
    if (peerErrorB) return [...problems, peerErrorB];
    docker(["restart", NAMES.asterisk], 60_000);
    if (!waitAsterisk()) return [...problems, "Asterisk startet in Phase b nicht"];
    const resultsB = waitPeers(180_000);
    problems.push(...runtimeProblems(resultsB, cfgB, RUNTIME, "b"));

    // fail2ban im Netz-Namensraum der Vermittlung, mit dem Jail aus dem Repo und anderer Zeitzone
    const jail = docker(["run", "-d", "--name", NAMES.fail2ban, "--network", `container:${NAMES.asterisk}`, "--cap-add", "NET_ADMIN", "--cap-add", "NET_RAW",
      "-e", "TZ=Europe/Berlin", "-v", `${join(DIR, "fail2ban", "sip-vermittlung.local")}:/data/jail.d/sip-vermittlung.local:ro`,
      "-v", `${join(workDir, "logs")}:/docker/sip-vermittlung/logs:ro`, FAIL2BAN_IMAGE], 300_000);
    if (jail.code !== 0) return [...problems, `fail2ban startet nicht: ${jail.out.slice(0, 300)}`];
    let jailReady = false;
    for (let i = 0; i < 30 && !jailReady; i++) {
      jailReady = docker(["exec", NAMES.fail2ban, "fail2ban-client", "status", "sip-vermittlung"], 10_000).code === 0;
      if (!jailReady) spawnSync("sleep", ["1"]);
    }
    if (!jailReady) return [...problems, `fail2ban-Jail nicht aktiv: ${docker(["logs", NAMES.fail2ban]).out.slice(-400)}`];
    const attack = parseProbes(docker(["run", "--rm", "--name", NAMES.attacker, "--network", NAMES.netElevenlabs, "--ip", ATTACKER_IP,
      "-v", `${join(DIR, "pruefung")}:/probe:ro`, "-v", `${join(workDir, "pki")}:/pki:ro`,
      PROBE_IMAGE, "python", "-I", "-u", "/probe/sip_probe.py", "angriff", probeConfig(cfgA)], 180_000).out).find(r => r.probe === "angriff");
    const f2bStatus = docker(["exec", NAMES.fail2ban, "fail2ban-client", "status", "sip-vermittlung"]).out;
    const f2bRegex = docker(["exec", NAMES.fail2ban, "fail2ban-regex", "/docker/sip-vermittlung/logs/messages", "asterisk"], 60_000).out;
    console.log(`  fail2ban: ${/Lines: .*matched/.exec(f2bRegex)?.[0] ?? "kein Ergebnis"}; Angreifer gesperrt: ${attack?.gesperrt} nach ${attack?.sekunden} s`);
    problems.push(...fail2banProblems(attack, f2bStatus, f2bRegex));

    // Beide Logwege: Datei für fail2ban und Docker-Log
    const logs = `${readFileSync(join(workDir, "logs", "messages"), "utf8")}\n${docker(["logs", NAMES.asterisk]).out}`;
    problems.push(...logProblems(logs, [RUNTIME.caller, RUNTIME.attacker, RUNTIME.forbidden, ...cfgA.allowedTargets, cfgA.easybellNumber]));

    for (const r of [...resultsA, ...resultsB, ...(attack ? [attack] : [])]) {
      if (r.probe !== "fertig") console.log(`  Probe ${r.probe}: ${summary(r)}`);
    }
    return problems;
  } finally {
    if (!process.env.SIP_PRUEFUNG_BEHALTEN) {
      cleanup();
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

function summary(r: ProbeResult): string {
  const { probe: _probe, kontakt: _kontakt, ...rest } = r;
  return Object.entries(rest).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
}

/**
 * Neustart-Nachweis: Debian mit systemd im Container, darin die Unit aus
 * systemd/ und eine Attrappe von docker.service, die bei ihrem Start
 * festhält, ob Tabelle und Marke schon da sind. Ein Neustart des Containers
 * ist ein Systemstart: /run und die nft-Regeln sind danach leer. Drei
 * Starts: mit Unit, ohne Unit (Gegenprobe), wieder mit Unit.
 */
export function runBootCheck(env: Env, workDir: string): string[] {
  rmSync(workDir, { recursive: true, force: true });
  const box = join(workDir, "sip-vermittlung");
  mkdirSync(join(workDir, "ergebnis"), { recursive: true });
  writeRendered(renderAll(env), join(box, "erzeugt"), { secretMode: 0o644 });
  for (const f of ["firewall.sh", "systemd"]) spawnSync("cp", ["-R", join(DIR, f), box]);
  docker(["rm", "-f", NAMES.systemd], 30_000);
  try {
    const build = docker(["build", "-q", "-t", SYSTEMD_IMAGE, "-f", join(DIR, "pruefung", "systemd.Dockerfile"), join(DIR, "pruefung")], 600_000);
    if (build.code !== 0) return [`Prüfbild mit systemd nicht gebaut: ${build.out.slice(-300)}`];
    const run = docker(["run", "-d", "--name", NAMES.systemd, "--privileged", "--cgroupns=private", "--network", "none",
      "--tmpfs", "/run", "--tmpfs", "/run/lock", "-v", `${box}:/docker/sip-vermittlung:ro`, "-v", `${join(workDir, "ergebnis")}:/ergebnis`, SYSTEMD_IMAGE]);
    if (run.code !== 0) return [`systemd-Container startet nicht: ${run.out.slice(0, 300)}`];
    const booted = () => {
      for (let i = 0; i < 60; i++) {
        const s = docker(["exec", NAMES.systemd, "systemctl", "is-system-running"], 10_000).out.trim();
        if (s === "running" || s === "degraded") return true;
        spawnSync("sleep", ["1"]);
      }
      return false;
    };
    if (!booted()) return ["systemd startet im Prüfcontainer nicht"];
    const sh = (cmd: string) => docker(["exec", NAMES.systemd, "sh", "-c", cmd], 60_000);
    const setup = sh([
      "cp /docker/sip-vermittlung/systemd/sip-vermittlung-firewall.service /etc/systemd/system/",
      "cat > /etc/systemd/system/docker.service <<'X'",
      "[Unit]",
      "Description=Attrappe von docker.service",
      "[Service]",
      "Type=oneshot",
      "RemainAfterExit=yes",
      "ExecStart=/bin/sh -c 't=nein; m=nein; nft list table inet sip_vermittlung >/dev/null 2>&1 && t=ja; [ -f /run/sip-vermittlung/geladen ] && m=ja; echo \"tabelle=$t marke=$m\" >> /ergebnis/docker-start.log'",
      "[Install]",
      "WantedBy=multi-user.target",
      "X",
      "systemctl daemon-reload",
      "systemctl enable docker.service sip-vermittlung-firewall.service",
    ].join("\n"));
    if (setup.code !== 0) return [`Units nicht eingerichtet: ${setup.out.slice(0, 300)}`];
    const reboot = (): string | null => {
      docker(["restart", NAMES.systemd], 60_000);
      return booted() ? null : "systemd startet nach dem Neustart nicht";
    };
    const problems: string[] = [];
    let err = reboot();
    if (err) return [err];
    const order = sh("systemctl show -p ActiveEnterTimestampMonotonic --value sip-vermittlung-firewall.service; systemctl show -p InactiveExitTimestampMonotonic --value docker.service").out.trim().split("\n").map(Number);
    if (!(order.length === 2 && order[0] > 0 && order[0] <= order[1])) problems.push(`Neustart: Firewall nicht vor Docker fertig (${order.join(" / ")})`);
    sh("systemctl disable sip-vermittlung-firewall.service");
    err = reboot();
    if (err) return [err];
    sh("systemctl enable sip-vermittlung-firewall.service");
    err = reboot();
    if (err) return [err];
    const lines = readFileSync(join(workDir, "ergebnis", "docker-start.log"), "utf8").trim().split("\n");
    console.log(`  Neustarts (mit Unit, ohne Unit, mit Unit): ${lines.join(" | ")}`);
    problems.push(...bootProblems(lines));
    return problems;
  } finally {
    docker(["rm", "-f", NAMES.systemd], 30_000);
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const env = parseEnvText(readFileSync(EXAMPLE_ENV, "utf8"));
  const cfg = parseConfig(env);
  const files = renderAll(env);
  const problems = staticProblems(files, cfg);
  console.log(`Statische Prüfung: ${files.length} Dateien erzeugt, ${problems.length ? `${problems.length} Fehler` : "bestanden"}`);
  if (process.argv.includes("--container")) {
    // Unter dem Projektordner: Colima und Docker Desktop teilen den Home-Ordner, nicht /tmp
    const tmp = join(DIR, "..", "..", "tmp");
    if (!existsSync(tmp)) mkdirSync(tmp);
    const found = runContainerCheck(env, join(tmp, "sip-vermittlung-pruefung"));
    console.log(`Containerprüfung: ${found.length ? `${found.length} Fehler` : "bestanden"}`);
    problems.push(...found);
    const boot = runBootCheck(env, join(tmp, "sip-vermittlung-neustart"));
    console.log(`Neustart-Prüfung: ${boot.length ? `${boot.length} Fehler` : "bestanden"}`);
    problems.push(...boot);
  }
  for (const p of problems) console.error(`- ${p}`);
  process.exit(problems.length ? 1 : 0);
}
