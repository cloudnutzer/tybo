/**
 * Issue #511: Generator, statische Prüfung, Auswertung der Laufzeitprüfung
 * und Skripte der SIP-Vermittlung (deploy/sip-vermittlung/). Das Verhalten
 * mit echtem Asterisk (Gespräche, Digest, Höchstdauer, fail2ban, Neustart)
 * prüft `bun run deploy/sip-vermittlung/pruefen.ts --container`; hier geht es
 * um das, was ohne Docker belegbar ist.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  confUri,
  fillTemplate,
  parseConfig,
  parseEnvText,
  parseOwner,
  renderAll,
  toE164,
  writeRendered,
  type Env,
  type RenderedFile,
} from "../deploy/sip-vermittlung/render";
import {
  ASTERISK_BASE_IMAGE,
  ASTERISK_IMAGE,
  bootProblems,
  EXAMPLE_ENV,
  FOLLOW_HOST,
  fail2banProblems,
  logProblems,
  RUNTIME,
  runtimeEnv,
  runtimeProblems,
  staticProblems,
  type ProbeResult,
} from "../deploy/sip-vermittlung/pruefen";

const DEPLOY = join(import.meta.dir, "..", "deploy", "sip-vermittlung");

const EXAMPLE = parseEnvText(readFileSync(EXAMPLE_ENV, "utf8"));
const ALLOWED = "+4915550100123";
const OTHER = "+4915550100999";

function env(overrides: Env = {}): Env {
  return { ...EXAMPLE, ...overrides };
}

function render(overrides: Env = {}): RenderedFile[] {
  return renderAll(env(overrides));
}

function get(files: RenderedFile[], path: string): string {
  return files.find(f => f.path === path)!.content;
}

function problemsOf(overrides: Env): string[] {
  try {
    parseConfig(env(overrides));
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
}

describe("Konfiguration aus der .env", () => {
  test("beispiel.env ist gültig und ergibt die Standardwerte", () => {
    const cfg = parseConfig(EXAMPLE);
    expect(cfg.allowedTargets).toEqual([ALLOWED]);
    expect(cfg.maxCalls).toBe(2);
    expect(cfg.maxMinutes).toBe(10);
    expect(cfg.easybellTransport).toBe("tls");
    expect(cfg.withheldCaller).toBe("ablehnen");
    expect(cfg.elevenlabsHost).toBe("sip.rtc.elevenlabs.io");
  });

  test("fehlende Zugangsdaten werden mit Namen gemeldet, ohne Werte", () => {
    const problems = problemsOf({ EASYBELL_PASSWORT: "", ELEVENLABS_AUS_BENUTZER: undefined });
    expect(problems).toContain("EASYBELL_PASSWORT fehlt");
    expect(problems).toContain("ELEVENLABS_AUS_BENUTZER fehlt");
  });

  test("ein Passwort mit ; (Kommentar in .conf) oder Leerzeichen wird abgelehnt, der Wert steht nicht in der Meldung", () => {
    const secret = "geheim;load=>x";
    const err = (() => {
      try {
        parseConfig(env({ ELEVENLABS_EIN_PASSWORT: secret }));
      } catch (e) {
        return e as ConfigError;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect(err!.message).toContain("ELEVENLABS_EIN_PASSWORT");
    expect(err!.message).not.toContain(secret);
    expect(problemsOf({ EASYBELL_PASSWORT: "mit leerzeichen 123" }).some(p => p.startsWith("EASYBELL_PASSWORT"))).toBe(true);
  });

  test("das eigene Passwort für ElevenLabs braucht mindestens 16 Zeichen", () => {
    expect(problemsOf({ ELEVENLABS_AUS_PASSWORT: "Kurz-1234567" })).toContain("ELEVENLABS_AUS_PASSWORT muss mindestens 16 Zeichen lang sein");
  });

  test("der Benutzername von ElevenLabs darf keinen Abschnitt in pjsip.conf überdecken", () => {
    for (const name of ["easybell", "anonymous", "elevenlabs", "transport-tls"]) {
      expect(problemsOf({ ELEVENLABS_AUS_BENUTZER: name })).toContain("ELEVENLABS_AUS_BENUTZER ist ein reservierter Name");
    }
  });

  test("Positivliste: ohne ERLAUBTE_ZIELE nur USER_PHONE_NUMBER, ohne beide nichts", () => {
    expect(parseConfig(env({ ERLAUBTE_ZIELE: undefined })).allowedTargets).toEqual([ALLOWED]);
    expect(parseConfig(env({ ERLAUBTE_ZIELE: `${OTHER}, 0049 155 50100123, ${OTHER}` })).allowedTargets).toEqual([OTHER, ALLOWED]);
    expect(problemsOf({ ERLAUBTE_ZIELE: "", USER_PHONE_NUMBER: "" })[0]).toContain("ohne Positivliste wählt die Vermittlung nichts");
    expect(problemsOf({ ERLAUBTE_ZIELE: `${ALLOWED},_X.` })).toContain("ERLAUBTE_ZIELE enthält einen Eintrag, der keine Rufnummer im Format +49… ist");
  });

  test("höchstens zwei Gespräche, Höchstdauer 1 bis 60 Minuten", () => {
    expect(problemsOf({ MAX_GESPRAECHE: "3" })).toContain("MAX_GESPRAECHE muss zwischen 1 und 2 liegen");
    expect(problemsOf({ MAX_GESPRAECHE: "0" })).toContain("MAX_GESPRAECHE muss zwischen 1 und 2 liegen");
    expect(problemsOf({ MAX_MINUTEN: "61" })).toContain("MAX_MINUTEN muss zwischen 1 und 60 liegen");
    expect(problemsOf({ MAX_MINUTEN: "zehn" })).toContain("MAX_MINUTEN muss eine ganze Zahl sein");
  });

  test("RTP-Bereich: gerade, groß genug für alle Gespräche, ohne SIP-Port", () => {
    expect(problemsOf({ RTP_START: "10001" })).toContain("RTP_START muss gerade sein");
    expect(problemsOf({ RTP_START: "10000", RTP_ENDE: "10005" })[0]).toContain("RTP-Bereich zu klein");
    expect(problemsOf({ RTP_START: "5000", RTP_ENDE: "5100", SIP_TLS_PORT: "5061" })).toContain("SIP_TLS_PORT liegt im RTP-Bereich");
  });

  test("Auswahlwerte außerhalb der Liste sind Fehler", () => {
    expect(problemsOf({ EASYBELL_TRANSPORT: "tcp" })[0]).toContain("EASYBELL_TRANSPORT");
    expect(problemsOf({ UNTERDRUECKTE_NUMMER: "vielleicht" })[0]).toContain("UNTERDRUECKTE_NUMMER");
  });

  test("Rufnummern werden zu E.164", () => {
    expect(toE164("+49 155 501-00123")).toBe(ALLOWED);
    expect(toE164("004915550100123")).toBe(ALLOWED);
    expect(toE164("015550100123")).toBeNull();
    expect(toE164("+49abc")).toBeNull();
  });

  test(".env-Text wie dotenv: Kommentare, Anführungszeichen, export", () => {
    expect(parseEnvText('# x\nA=1 # Kommentar\nexport B="2 3"\nC=\'4\'\n\nkaputt')).toEqual({ A: "1", B: "2 3", C: "4" });
  });

  test("Besitzer als uid:gid", () => {
    expect(parseOwner("1000:1000")).toEqual({ uid: 1000, gid: 1000 });
    expect(() => parseOwner("asterisk")).toThrow(ConfigError);
  });
});

describe("Platzhalter", () => {
  test("ersetzt nur {{NAME}}, Asterisk-Ausdrücke bleiben", () => {
    expect(fillTemplate("t", "a={{A}} b=${EXTEN} c=$[1+1]", { A: "x" })).toBe("a=x b=${EXTEN} c=$[1+1]");
  });

  test("ein unbekannter Platzhalter bricht ab", () => {
    expect(() => fillTemplate("t", "{{A}} {{B}}", { A: "x" })).toThrow("unbekannte Platzhalter B");
  });

  test("in keiner erzeugten Datei bleibt ein Platzhalter offen, in beiden Transportarten", () => {
    for (const transport of ["tls", "udp"]) {
      for (const f of render({ EASYBELL_TRANSPORT: transport, UNTERDRUECKTE_NUMMER: "annehmen" })) {
        expect(f.content).not.toMatch(/\{\{|\}\}/);
      }
    }
  });
});

describe("Wählplan", () => {
  const files = render();
  const ext = get(files, "asterisk/extensions.conf");

  test("ausgehend wird nur die Positivliste gewählt, jede Nummer als exakter Vergleich", () => {
    const checks = ext.split("\n").filter(l => l.includes('GotoIf($["${ZIEL}" = '));
    expect(checks).toEqual([` same => n,GotoIf($["\${ZIEL}" = "${ALLOWED}"]?erlaubt)`]);
    expect(ext).not.toContain(OTHER);
    // Abweisen steht direkt nach der Liste: kein Weg führt an ihr vorbei zum Wählen
    const lines = ext.split("\n");
    const lastCheck = lines.findLastIndex(l => l.includes('GotoIf($["${ZIEL}" = '));
    expect(lines[lastCheck + 1]).toContain("n(abweisen),Log(NOTICE,Ausgehend abgewiesen");
    expect(lines[lastCheck + 2]).toBe(" same => n,Hangup(21)");
    expect(ext).toContain('GotoIf($["${ZIEL}" != "${ROH}"]?abweisen)');
  });

  test("mehrere erlaubte Ziele ergeben je eine Zeile", () => {
    const multi = get(render({ ERLAUBTE_ZIELE: `${ALLOWED},${OTHER}` }), "asterisk/extensions.conf");
    expect(multi.split("\n").filter(l => l.includes('GotoIf($["${ZIEL}" = ')).length).toBe(2);
  });

  test("beide Richtungen: Höchstdauer und absolute Frist gesetzt", () => {
    const dials = ext.split("\n").filter(l => l.includes("Dial("));
    expect(dials).toHaveLength(2);
    for (const d of dials) expect(d).toContain("iS(600)");
    expect(ext.match(/Set\(TIMEOUT\(absolute\)=690\)/g)).toHaveLength(2);
    expect(get(render({ MAX_MINUTEN: "1" }), "asterisk/extensions.conf")).toContain("S(60)");
  });

  test("beide Richtungen laufen durch denselben Zähler mit Grenze", () => {
    expect(ext.match(/Gosub\(gespraeche-zaehlen,s,1\)/g)).toHaveLength(2);
    expect(ext).toContain("GotoIf($[${GROUP_COUNT(gespraech@vermittlung)} > 2]?voll)");
    expect(get(render({ MAX_GESPRAECHE: "1" }), "asterisk/extensions.conf")).toContain("> 1]?voll");
  });

  test("unterdrückte Nummer auf dem easybell-Weg: Standard ablehnen, sonst nur anonym weiter", () => {
    expect(ext).toContain(" same => n(unterdrueckt),Log(NOTICE,Eingehend mit unterdrueckter Nummer abgewiesen)\n same => n,Hangup(21)");
    const accept = get(render({ UNTERDRUECKTE_NUMMER: "annehmen" }), "asterisk/extensions.conf");
    expect(accept).toContain(" same => n,Set(ANRUFER=anonymous)\n same => n,Set(CALLERID(name)=)\n same => n,Set(CALLERID(num)=anonymous)\n same => n,Goto(weiter)");
  });

  test("Anzeige nicht erlaubt (Privacy: id) zählt als unterdrückt, auch wenn eine Nummer da ist", () => {
    const lines = ext.split("\n");
    const pres = lines.findIndex(l => l.includes('GotoIf($["${CALLERID(num-pres):0:7}" != "allowed"]?unterdrueckt)'));
    // geprüft, bevor die Nummer übernommen oder weitergegeben wird
    expect(pres).toBeGreaterThan(-1);
    expect(pres).toBeLessThan(lines.findIndex(l => l.includes("Set(ANRUFER=${FILTER(")));
    expect(pres).toBeLessThan(lines.findIndex(l => l.includes("Dial(PJSIP/")));
  });

  test("die Anrufernummer geht als X-Caller-ID mit, eingehend wählt nur ElevenLabs mit der eigenen Nummer", () => {
    expect(ext).toContain("Set(PJSIP_HEADER(add,X-Caller-ID)=${ARG1})");
    expect(ext).toContain("Dial(PJSIP/+4930123456789@elevenlabs,30,b(kopfzeilen-elevenlabs^s^1(${ANRUFER}))iS(600))");
  });

  test("Umleitungen (302) folgt keiner der beiden Wege", () => {
    expect(ext).toContain("Dial(PJSIP/${WAHL}@easybell,60,iS(600))");
    for (const d of ext.split("\n").filter(l => l.includes("Dial("))) expect(d).toMatch(/[,)]iS\(/);
  });

  test("Logzeilen kürzen Rufnummern", () => {
    for (const line of ext.split("\n").filter(l => l.includes("Log("))) {
      expect(line).not.toMatch(/\$\{(ANRUFER|ZIEL|ROH|EXTEN|WAHL)\}/);
    }
  });

  test("Wählformat für easybell", () => {
    expect(get(render({ EASYBELL_WAHLFORMAT: "00" }), "asterisk/extensions.conf")).toContain("Set(WAHL=00${ZIEL:1})");
    expect(get(render({ EASYBELL_WAHLFORMAT: "national" }), "asterisk/extensions.conf")).toContain('Set(WAHL=${IF($["${ZIEL:0:3}" = "+49"]?0${ZIEL:3}:00${ZIEL:1})})');
  });
});

describe("SIP-Wege", () => {
  test("kein anonymer Endpunkt, keine Zuordnung über den From-Namen, ElevenLabs nur mit Digest", () => {
    const pjsip = get(render(), "asterisk/pjsip.conf");
    expect(pjsip).not.toMatch(/^\[anonymous\]/m);
    expect(pjsip).not.toContain("alwaysauthreject");
    expect(pjsip).toMatch(/^\[vermittlung-her\]\ntype = endpoint\n[^[]*context = von-elevenlabs\n[^[]*auth = elevenlabs-aus-auth\nidentify_by = auth_username$/m);
    expect(pjsip.match(/^identify_by = ip$/gm)).toHaveLength(2);
    expect(pjsip).not.toMatch(/^type = identify$/m);
    expect(pjsip).toContain("line = yes\nendpoint = easybell");
  });

  test("TLS mit SRTP als Standard, UDP nur auf Wunsch", () => {
    const tls = get(render(), "asterisk/pjsip.conf");
    expect(tls).not.toContain("[transport-udp]");
    // Asterisk liest ein ungeschütztes ; als Kommentar: ohne Rückstrich fiele transport=tls weg
    expect(tls).toContain("server_uri = sip:voip.easybell.de:5061\\;transport=tls");
    expect(tls).toContain("contact = sip:voip.easybell.de:5061\\;transport=tls");
    expect(tls).toContain("contact = sip:sip.rtc.elevenlabs.io:5061\\;transport=tls");
    expect(tls).not.toMatch(/[^\\];transport=/);
    expect(tls.match(/^media_encryption = sdes$/gm)).toHaveLength(3);
    const udp = render({ EASYBELL_TRANSPORT: "udp" });
    expect(get(udp, "asterisk/pjsip.conf")).toContain("[transport-udp]\ntype=transport\nprotocol=udp\nbind=0.0.0.0:5060");
    expect(get(udp, "asterisk/pjsip.conf")).toContain("server_uri = sip:voip.easybell.de:5060\n");
    expect(get(udp, "firewall.nft")).toContain("udp dport 5060 ip saddr @easybell accept\n    udp dport 5060 drop");
    expect(get(render(), "firewall.nft")).not.toMatch(/udp dport 5060/);
  });

  test("TLS prüft den Namen der Gegenstelle und nimmt Wildcard-Zertifikate an (Folgeverbindungen zu ElevenLabs)", () => {
    const pjsip = get(render(), "asterisk/pjsip.conf");
    expect(pjsip).toMatch(/^\[transport-tls\]\ntype = transport\n[^[]*verify_server = yes\nallow_wildcard_certs = yes\n/m);
  });

  test("Firewall gibt nur TLS-Port und RTP-Bereich frei", () => {
    const nft = get(render({ SIP_TLS_PORT: "5071", RTP_START: "12000", RTP_ENDE: "12011" }), "firewall.nft");
    expect(nft).toContain("tcp dport 5071 accept");
    expect(nft).toContain("udp dport 12000-12011 accept");
    expect(nft).toContain("table inet sip_vermittlung {");
  });
});

describe("statische Prüfung (pruefen.ts)", () => {
  const cfg = parseConfig(EXAMPLE);

  test("die erzeugte Konfiguration besteht", () => {
    expect(staticProblems(render(), cfg)).toEqual([]);
  });

  function tampered(path: string, edit: (s: string) => string): RenderedFile[] {
    return render().map(f => (f.path === path ? { ...f, content: edit(f.content) } : f));
  }

  test("erkennt REFER, Aufnahme, fremde Ziele, fehlende Höchstdauer und anonyme Wege", () => {
    expect(staticProblems(tampered("asterisk/modules.conf", s => `${s}load => res_pjsip_refer.so\n`), cfg)).toContain("modules.conf: res_pjsip_refer darf nicht geladen werden");
    expect(staticProblems(tampered("asterisk/modules.conf", s => `${s}load => app_mixmonitor.so\n`), cfg)).toContain("modules.conf: app_mixmonitor darf nicht geladen werden");
    expect(staticProblems(tampered("asterisk/extensions.conf", s => s.replace("?erlaubt)", `?erlaubt)\n same => n,GotoIf($["\${ZIEL}" = "${OTHER}"]?erlaubt)`)), cfg)).toContain("extensions.conf: Positivliste weicht von der Konfiguration ab");
    expect(staticProblems(tampered("asterisk/extensions.conf", s => s.replace(",iS(600))", ",i)")), cfg)).toContain("extensions.conf: Dial ohne Höchstdauer");
    expect(staticProblems(tampered("asterisk/pjsip.conf", s => `${s}\n[anonymous]\ntype = endpoint\n`), cfg)).toContain("pjsip.conf: anonymer Endpunkt");
    expect(staticProblems(tampered("asterisk/pjsip.conf", s => s.replace(/^identify_by = auth_username$/m, "identify_by = username,auth_username")), cfg).join("\n")).toContain("fälschbar");
    expect(staticProblems(tampered("asterisk/logger.conf", s => s.replace("console => notice", "console => verbose,notice")), cfg)).toContain("logger.conf: verbose, debug oder dtmf im Log");
    expect(staticProblems(tampered("asterisk/logger.conf", s => `${s}messages => notice\n`), cfg)).toContain("logger.conf: Asterisk darf nur auf die Konsole schreiben, nicht ungefiltert in eine Datei");
    expect(staticProblems(tampered("asterisk/pjsip.conf", s => s.replaceAll("\\;transport=tls", ";transport=tls")), cfg).join("\n")).toContain("ungeschütztes ;");
    expect(staticProblems(tampered("asterisk/extensions.conf", s => s.replace(",iS(600))", ",S(600))")), cfg)).toContain("extensions.conf: Dial folgt Umleitungen (Option i fehlt)");
    expect(staticProblems(tampered("asterisk/extensions.conf", s => s.replace("Ausgehend an ${ZIEL:0:6}", "Ausgehend an ${ZIEL}")), cfg)).toContain("extensions.conf: Log mit ungekürzter Rufnummer");
  });

  test("erkennt fehlende Namensprüfung und fehlende Wildcard-Zertifikate", () => {
    expect(staticProblems(tampered("asterisk/pjsip.conf", s => s.replace("allow_wildcard_certs = yes\n", "")), cfg)).toContain("pjsip.conf [transport-tls]: allow_wildcard_certs fehlt (Wildcard-Zertifikate von ElevenLabs)");
    expect(staticProblems(tampered("asterisk/pjsip.conf", s => s.replace("verify_server = yes", "verify_server = no")), cfg)).toContain("pjsip.conf [transport-tls]: verify_server muss yes sein");
  });
});

describe("Auswertung der Laufzeitprüfung", () => {
  const cfgA = parseConfig(runtimeEnv(EXAMPLE, "a"));
  const cfgB = parseConfig(runtimeEnv(EXAMPLE, "b"));
  const caller = RUNTIME.caller;
  const reg = { probe: "registrierung", registriert: true, kontakt_tls: true, kontakt_line: true, via_tls: true, register_an: "sip:voip.easybell.de:5061;transport=tls" };
  const inbound = { status: 200, elevenlabs_invites: 1, ruri_user: "+4930123456789", from_user: caller, pai: `<sip:${caller}@sip.example.org>`, x_caller_id: caller, bye: 200, gegenseite_beendet: true };
  const outbound = { erste: 401, status: 200, easybell_invites: 1, ruri_user: ALLOWED, from_user: "beispiel-benutzer", bye: 200, gegenseite_beendet: true };
  const refer = { aufgebaut: true, refer: null, neue_invites: 0, bye: 200 };
  // Werte aus pruefen.ts --container mit dem Image aus image/ (6.11.2026)
  const follow = { aufgebaut: true, ack_ueber_folgeverbindung: true, alte_verbindungen_zu: true, bye: 200, bye_angekommen: true, bye_ueber_neue_verbindung: true, verbindungsversuche: 2, anfragen: 2 };
  const followRejected = { ...follow, ack_ueber_folgeverbindung: false, bye_angekommen: false, bye_ueber_neue_verbindung: false, anfragen: 0, sni: [FOLLOW_HOST] };
  const goodA: ProbeResult[] = [
    reg,
    { probe: "ohne_anmeldung_als_easybell", erste: 401, status: 401 },
    { probe: "ohne_anmeldung_als_elevenlabs", erste: 401, status: 401 },
    { probe: "falsches_passwort", erste: 401, status: 401 },
    { probe: "unbekannter_benutzer", erste: 401, status: 401 },
    { probe: "verbotenes_ziel", erste: 401, status: 403, easybell_invites: 0 },
    { probe: "buchstaben_als_ziel", erste: 401, status: 404 },
    { probe: "eingehend_ohne_line", erste: 401, status: 401, elevenlabs_invites: 0 },
    { probe: "eingehend_falsche_line", erste: 401, status: 401, elevenlabs_invites: 0 },
    { probe: "eingehend", ...inbound },
    { probe: "eingehend_national", ...inbound, pai: null },
    { probe: "ausgehend", ...outbound },
    { probe: "ausgehend_national", ...outbound },
    { probe: "folgeverbindung_wildcard", ...follow, sni: [FOLLOW_HOST] },
    { probe: "folgeverbindung_falscher_name", ...followRejected },
    { probe: "folgeverbindung_erster_name", ...followRejected },
    { probe: "folgeverbindung_ip_adresse", ...follow, sni: ["sip.rtc.elevenlabs.io"] },
    { probe: "unterdrueckt_privacy_id", status: 403, elevenlabs_invites: 0 },
    { probe: "unterdrueckt_anonym", status: 403, elevenlabs_invites: 0 },
    { probe: "dritter_anruf", erste_beiden: [true, true], dritter_eingehend: 503, dritter_ausgehend: 503, neue_invites: 0 },
    { probe: "parallelstart_gemischt", aufgebaut: 2, codes: [200, 200, 503] },
    { probe: "parallelstart_ausgehend", aufgebaut: 2, codes: [200, 503, 200] },
    { probe: "parallelstart_eingehend", aufgebaut: 1, codes: [200, 503, 503] },
    { probe: "frei_nach_parallelstart", ...outbound },
    { probe: "weiterleitung_eingehend", status: 603, easybell_ziele: [] },
    { probe: "weiterleitung_ausgehend", status: 603, easybell_ziele: [ALLOWED], elevenlabs_invites: 0 },
    { probe: "refer_von_elevenlabs_eingehend", ...refer },
    { probe: "refer_von_easybell_eingehend", ...refer, refer: 405 },
    { probe: "refer_von_elevenlabs_ausgehend", ...refer },
    { probe: "refer_von_easybell_ausgehend", ...refer },
    { probe: "hoechstdauer", grenze: 60, eingehend_easybell: 60, eingehend_elevenlabs: 60, ausgehend_elevenlabs: 60.1, ausgehend_easybell: 60, beendet_durch: ["vermittlung"] },
  ];
  const goodB: ProbeResult[] = [
    reg,
    { probe: "annehmen_unterdrueckt_privacy_id", status: 200, x_caller_id: "anonymous", nummer_bei_elevenlabs: false, elevenlabs_invites: 1 },
    { probe: "annehmen_unterdrueckt_anonym", status: 200, x_caller_id: "anonymous" },
    { probe: "annehmen_sichtbar", status: 200, x_caller_id: caller },
  ];
  const change = (results: ProbeResult[], name: string, patch: Record<string, unknown>) => results.map(r => (r.probe === name ? { ...r, ...patch } : r));
  const failing = (results: ProbeResult[], phase: "a" | "b") => runtimeProblems(results, phase === "a" ? cfgA : cfgB, RUNTIME, phase).map(p => p.split(":")[0]);

  test("die Laufzeitprüfung läuft mit einer Minute Höchstdauer, Phase b nimmt unterdrückte Nummern an", () => {
    expect(cfgA.maxMinutes).toBe(1);
    expect(cfgA.withheldCaller).toBe("ablehnen");
    expect(cfgB.withheldCaller).toBe("annehmen");
  });

  test("erwartete Ergebnisse bestehen", () => {
    expect(runtimeProblems(goodA, cfgA, RUNTIME, "a")).toEqual([]);
    expect(runtimeProblems(goodB, cfgB, RUNTIME, "b")).toEqual([]);
  });

  test("Registrierung ohne transport=tls im Contact oder ohne line= fällt auf", () => {
    expect(failing(change(goodA, "registrierung", { kontakt_tls: false }), "a")).toContain("registrierung");
    expect(failing(change(goodA, "registrierung", { register_an: "sip:voip.easybell.de:5061" }), "a")).toContain("registrierung");
    expect(failing(change(goodA, "registrierung", { kontakt_line: false }), "a")).toContain("registrierung");
  });

  test("Privacy: id mit weitergereichter Nummer fällt in beiden Einstellungen auf", () => {
    expect(failing(change(goodA, "unterdrueckt_privacy_id", { status: 200, elevenlabs_invites: 1 }), "a")).toContain("unterdrueckt_privacy_id");
    expect(failing(change(goodB, "annehmen_unterdrueckt_privacy_id", { nummer_bei_elevenlabs: true }), "b")).toContain("annehmen_unterdrueckt_privacy_id");
    expect(failing(change(goodB, "annehmen_unterdrueckt_privacy_id", { x_caller_id: caller }), "b")).toContain("annehmen_unterdrueckt_privacy_id");
  });

  test("ein 503 oder eine fehlende Antwort gilt nicht als erfolgreicher Wählpfad", () => {
    for (const status of [503, null, undefined, 486]) {
      expect(failing(change(goodA, "ausgehend", { status }), "a")).toContain("ausgehend");
      expect(failing(change(goodA, "eingehend", { status }), "a")).toContain("eingehend");
    }
    expect(failing(change(goodA, "ausgehend", { easybell_invites: 0 }), "a")).toContain("ausgehend");
  });

  test("Folgeverbindung mit Zertifikat *.hosts.rtc.elevenlabs.io: ACK und BYE müssen ankommen, mit SNI des Contacts", () => {
    // Ergebnis des unveränderten Standard-Images (Gegenprobe vom 6.11.2026): Namensprüfung gegen sip.rtc.elevenlabs.io
    const unpatched = { ...followRejected, sni: ["sip.rtc.elevenlabs.io"] };
    expect(failing(change(goodA, "folgeverbindung_wildcard", unpatched), "a")).toContain("folgeverbindung_wildcard");
    expect(failing(change(goodA, "folgeverbindung_wildcard", { bye_angekommen: false, bye_ueber_neue_verbindung: false }), "a")).toContain("folgeverbindung_wildcard");
    expect(failing(change(goodA, "folgeverbindung_wildcard", { bye_ueber_neue_verbindung: false }), "a")).toContain("folgeverbindung_wildcard");
    expect(failing(change(goodA, "folgeverbindung_wildcard", { ack_ueber_folgeverbindung: false }), "a")).toContain("folgeverbindung_wildcard");
    expect(failing(change(goodA, "folgeverbindung_wildcard", { alte_verbindungen_zu: false }), "a")).toContain("folgeverbindung_wildcard");
    expect(failing(change(goodA, "folgeverbindung_wildcard", { sni: ["sip.rtc.elevenlabs.io"] }), "a")).toContain("folgeverbindung_wildcard");
    expect(failing(change(goodA, "folgeverbindung_wildcard", { bye: null }), "a")).toContain("folgeverbindung_wildcard");
  });

  test("Folgeverbindung: ein anderer Name am Contact, auch der der ersten Verbindung, wird abgelehnt", () => {
    for (const probe of ["folgeverbindung_falscher_name", "folgeverbindung_erster_name"]) {
      expect(failing(change(goodA, probe, { anfragen: 1, bye_angekommen: true }), "a")).toContain(probe);
      expect(failing(change(goodA, probe, { ack_ueber_folgeverbindung: true }), "a")).toContain(probe);
      // ohne Verbindungsversuch ist nichts über die Namensprüfung belegt
      expect(failing(change(goodA, probe, { verbindungsversuche: 0 }), "a")).toContain(probe);
    }
    // unverändertes Standard-Image: Zertifikat sip.rtc.elevenlabs.io am Contact wurde angenommen
    expect(failing(change(goodA, "folgeverbindung_erster_name", { ...follow, sni: ["sip.rtc.elevenlabs.io"] }), "a")).toContain("folgeverbindung_erster_name");
  });

  test("Folgeverbindung: Contact als IP-Adresse nimmt weiter den Namen der ersten Verbindung", () => {
    expect(failing(change(goodA, "folgeverbindung_ip_adresse", { bye_angekommen: false, bye_ueber_neue_verbindung: false, anfragen: 0 }), "a")).toContain("folgeverbindung_ip_adresse");
    expect(failing(change(goodA, "folgeverbindung_ip_adresse", { sni: [""] }), "a")).toContain("folgeverbindung_ip_adresse");
    for (const probe of ["folgeverbindung_erster_name", "folgeverbindung_falscher_name", "folgeverbindung_wildcard", "folgeverbindung_ip_adresse"]) {
      expect(failing(goodA.filter(r => r.probe !== probe), "a")).toContain(probe);
    }
  });

  test("fehlende Anrufernummer, dritter Anruf, Parallelstart, Umleitung, REFER und Höchstdauer fallen auf", () => {
    expect(failing(change(goodA, "eingehend", { x_caller_id: null }), "a")).toContain("eingehend");
    expect(failing(change(goodA, "dritter_anruf", { dritter_ausgehend: 200 }), "a")).toContain("dritter_anruf");
    expect(failing(change(goodA, "parallelstart_gemischt", { aufgebaut: 3, codes: [200, 200, 200] }), "a")).toContain("parallelstart_gemischt");
    expect(failing(change(goodA, "weiterleitung_ausgehend", { elevenlabs_invites: 1 }), "a")).toContain("weiterleitung_ausgehend");
    expect(failing(change(goodA, "weiterleitung_eingehend", { easybell_ziele: [RUNTIME.forbidden.slice(1)] }), "a")).toContain("weiterleitung_eingehend");
    expect(failing(change(goodA, "refer_von_elevenlabs_eingehend", { refer: 202 }), "a")).toContain("refer_von_elevenlabs_eingehend");
    expect(failing(change(goodA, "refer_von_easybell_ausgehend", { neue_invites: 1 }), "a")).toContain("refer_von_easybell_ausgehend");
    expect(failing(change(goodA, "hoechstdauer", { ausgehend_easybell: null }), "a")).toContain("hoechstdauer");
    expect(failing(change(goodA, "hoechstdauer", { eingehend_elevenlabs: 95 }), "a")).toContain("hoechstdauer");
    expect(failing(goodA.filter(r => r.probe !== "hoechstdauer"), "a")).toContain("hoechstdauer");
  });

  const logs = [
    `[2026-11-06 12:41:42] NOTICE[56]: res_pjsip/pjsip_distributor.c:722 log_failed_request: Request 'INVITE' from '<sip:+49176...@x>' failed for '10.231.12.200:60652' (callid: a) - No matching endpoint found`,
    `[2026-11-06 12:41:42] SECURITY[70]: res_security_log.c:114 security_event_stasis_cb: SecurityEvent="InvalidAccountID",AccountID="+49176...",LocalAddress="IPV4/TLS/10.231.12.3/5061",RemoteAddress="IPV4/TLS/10.231.12.200/60652"`,
    "NOTICE Ausgehend abgewiesen: Ziel +49155... nicht in der Positivliste",
  ].join("\n");

  test("Logs: gekürzte Nummern bestehen, jede volle Schreibweise fällt auf", () => {
    const numbers = [caller, RUNTIME.attacker, ALLOWED];
    expect(logProblems(logs, numbers)).toEqual([]);
    for (const leak of [caller, caller.slice(1), `0${caller.slice(3)}`]) {
      expect(logProblems(`${logs}\nfrom '<sip:${leak}@x>'`, numbers)).toContain("Log enthält eine ungekürzte Rufnummer (+49176...)");
    }
    expect(logProblems(logs.replace(/RemoteAddress="[^"]*"/, ""), numbers)).toContain("Log: Sicherheitsereignis mit Absenderadresse für fail2ban fehlt");
    expect(logProblems(`${logs}\nWARNING No application 'ExecIf' for extension`, numbers).some(p => p.includes("No application"))).toBe(true);
  });

  test("fail2ban: Treffer, Sperre und Wirkung", () => {
    const attack: ProbeResult = { probe: "angriff", ip: "10.231.12.200", codes: [401, 401, 401], gesperrt: true };
    const status = "Status for the jail: sip-vermittlung\n`- Actions\n   |- Currently banned: 2\n   `- Banned IP list: 10.231.12.2 10.231.12.200";
    const regex = "Lines: 146 lines, 0 ignored, 50 matched, 96 missed";
    expect(fail2banProblems(attack, status, regex)).toEqual([]);
    expect(fail2banProblems(attack, status.replace(" 10.231.12.200", ""), regex)).toContain("fail2ban hat die Adresse des Angreifers nicht gesperrt");
    expect(fail2banProblems({ ...attack, gesperrt: false }, status, regex)).toContain("die gesperrte Adresse erreicht die Vermittlung weiterhin");
    expect(fail2banProblems(attack, status, "Lines: 146 lines, 0 ignored, 0 matched")[0]).toContain("fail2ban-Filter trifft 0 Zeilen");
    expect(fail2banProblems({ ...attack, codes: [401, 401, 401, 401, null] }, status, regex)).toEqual([]);
    expect(fail2banProblems({ ...attack, codes: [null] }, status, regex)).toContain("Angreifer war schon vor seinen Versuchen gesperrt oder nicht erreichbar");
    expect(fail2banProblems({ ...attack, codes: [401, 200, 401] }, status, regex)).toContain("Anmeldeversuche des Angreifers wurden nicht abgewiesen");
    expect(fail2banProblems(undefined, status, regex)).toContain("Angriffsprobe ohne Ergebnis");
  });

  test("Neustart: Tabelle und Marke vor Docker, Gegenprobe ohne Unit", () => {
    expect(bootProblems(["tabelle=ja marke=ja", "tabelle=nein marke=nein", "tabelle=ja marke=ja"])).toEqual([]);
    expect(bootProblems(["tabelle=nein marke=nein", "tabelle=nein marke=nein", "tabelle=nein marke=nein"])).toHaveLength(1);
    expect(bootProblems(["tabelle=ja marke=ja", "tabelle=ja marke=ja", "tabelle=ja marke=ja"])).toHaveLength(1);
  });
});

describe("Logfilter (container/logfilter.pl)", () => {
  function filter(lines: string[]): { out: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), "sipv-log-"));
    try {
      const r = Bun.spawnSync(["perl", join(DEPLOY, "container", "logfilter.pl"), join(dir, "messages")], { stdin: Buffer.from(`${lines.join("\n")}\n`) });
      expect(r.exitCode).toBe(0);
      return { out: r.stdout.toString(), file: readFileSync(join(dir, "messages"), "utf8") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("kürzt Nummern in From, Anzeigename, Benutzername und Extension, in Datei und Ausgabe gleich", () => {
    const { out, file } = filter([
      `[2026-11-06 12:20:21] NOTICE[44]: res_pjsip/pjsip_distributor.c:722 log_failed_request: Request 'INVITE' from '"0176 1234 5678" <sip:+4917612345678@x.invalid>' failed for '10.20.30.255:40604' (callid: 1) - No matching endpoint found`,
      `[2026-11-06 12:20:21] SECURITY[58]: res_security_log.c:114 security_event_stasis_cb: SecurityEvent="InvalidPassword",EventTV="2026-11-06T12:20:21.390+0000",AccountID="+49-176-1234-5678",LocalAddress="IPV4/TLS/127.0.0.1/5061",RemoteAddress="IPV4/TLS/192.168.100.200/40594"`,
      "Call to extension '*31#004917612345678' rejected",
    ]);
    expect(out).toBe(file);
    expect(out).not.toMatch(/\d{7}/);
    expect(out).not.toContain("1234");
    expect(out).toContain(`from '"01761..." <sip:+49176...@x.invalid>'`);
    expect(out).toContain('AccountID="+49176..."');
    expect(out).toContain("'*31#00491...'");
  });

  test("Zeitstempel, Adressen und Ports bleiben für fail2ban stehen", () => {
    const { out } = filter([
      `[2026-11-06 12:20:21] NOTICE[44]: x: Request 'INVITE' from '<sip:+4917612345678@x>' failed for '10.20.30.255:40604' (callid: 1) - No matching endpoint found`,
      `[2026-11-06 12:20:21] SECURITY[58]: x: SecurityEvent="ChallengeResponseFailed",EventTV="2026-11-06T12:20:21.390+0000",RemoteAddress="IPV4/TLS/192.168.100.200/40594"`,
    ]);
    expect(out).toContain("[2026-11-06 12:20:21] NOTICE[44]");
    expect(out).toContain("failed for '10.20.30.255:40604'");
    expect(out).toContain('RemoteAddress="IPV4/TLS/192.168.100.200/40594"');
    expect(out).toContain('EventTV="2026-11-06T12:20:21.390+0000"');
  });

  test("Rufnummern in Form einer IPv4-Adresse oder eines Datums werden außerhalb der Adressfelder gekürzt, in Datei und Ausgabe", () => {
    const { out, file } = filter([
      `[2026-11-06 12:20:21] NOTICE[44]: res_pjsip/pjsip_distributor.c:722 log_failed_request: Request 'INVITE' from '<sip:030.123.45.67@x.invalid>' failed for '10.20.30.255:40604' (callid: 1) - No matching endpoint found`,
      `[2026-11-06 12:20:21] SECURITY[58]: res_security_log.c:114 security_event_stasis_cb: SecurityEvent="InvalidAccountID",EventTV="2026-11-06T12:20:21.390+0000",AccountID="030.123.45.67",LocalAddress="IPV4/TLS/10.231.12.3/5061",RemoteAddress="IPV4/TLS/192.168.100.200/40594"`,
      `[2026-11-06 12:20:21] SECURITY[58]: res_security_log.c:114 security_event_stasis_cb: SecurityEvent="ChallengeResponseFailed",AccountID="0301-12-34",RemoteAddress="IPV4/TLS/192.168.100.200/40594"`,
    ]);
    for (const log of [out, file]) {
      expect(log).not.toContain("123.45.67");
      expect(log).not.toContain("0301-12-34");
      expect(log).toContain("<sip:03012...@x.invalid>");
      expect(log).toContain('AccountID="03012..."');
      expect(log).toContain('AccountID="03011..."');
      // Adressen für fail2ban bleiben vollständig
      expect(log).toContain("failed for '10.20.30.255:40604'");
      expect(log).toContain('LocalAddress="IPV4/TLS/10.231.12.3/5061"');
      expect(log.match(/RemoteAddress="IPV4\/TLS\/192\.168\.100\.200\/40594"/g)).toHaveLength(2);
      expect(log).toContain('EventTV="2026-11-06T12:20:21.390+0000"');
    }
    expect(out).toBe(file);
  });
});

describe("Asterisk-Image mit pjproject-Patch (image/)", () => {
  const dockerfile = readFileSync(join(DEPLOY, "image", "Dockerfile"), "utf8");
  const patch = readFileSync(join(DEPLOY, "image", "0100-tls-folgeverbindung-zielname.patch"), "utf8");

  test("compose baut das Image aus image/ unter dem Tag, den die Prüfung nutzt", () => {
    const compose = readFileSync(join(DEPLOY, "compose.yaml"), "utf8");
    expect(compose).toContain("build: ./image");
    expect(compose).toContain(`image: ${ASTERISK_IMAGE}`);
    expect(compose).toContain("pull_policy: build");
    expect(compose).not.toContain(`image: ${ASTERISK_BASE_IMAGE}`);
  });

  test("Dockerfile: Standard-Image mit festem Tag, Patch im pjproject von Asterisk, Symbolvergleich", () => {
    const froms = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map(m => m[1]);
    expect(froms.at(-1)).toBe(ASTERISK_BASE_IMAGE);
    expect(froms[0]).toMatch(/^debian:trixie@sha256:[0-9a-f]{64}$/);
    expect(dockerfile).toContain("COPY 0100-tls-folgeverbindung-zielname.patch third-party/pjproject/patches/");
    expect(dockerfile).toMatch(/asterisk-22\.11\.0\.tar\.gz \\\n && echo "[0-9a-f]{64} {2}\/tmp\/asterisk\.tar\.gz" \| sha256sum -c -/);
    expect(dockerfile).toContain("--with-pjproject-bundled");
    expect(dockerfile).toContain("cmp /tmp/symbole.alt /tmp/symbole.neu");
    expect(dockerfile).toContain('grep -q "Using next hop name" main/libasteriskpj.so.2');
  });

  test("Patch: Zielname statt initial_dest nur für Rechnernamen, IP-Adressen behalten den Namen der ersten Verbindung", () => {
    expect(patch).toContain("--- a/pjsip/src/pjsip/sip_util.c\n+++ b/pjsip/src/pjsip/sip_util.c\n");
    expect(patch).toContain("+        } else if (!is_ip_literal(&dest_info.addr.host) &&");
    expect(patch).toContain("+    return pj_inet_pton(pj_AF_INET(), host, &addr4) == PJ_SUCCESS ||");
    expect(patch).toContain('+            PJ_LOG(5, (THIS_FILE, "Using next hop name %.*s instead of "');
    // Der Patch fügt nur hinzu, an der Prüfung selbst (verify_server, allow_wildcard_certs) ändert er nichts
    expect(patch.split("\n").filter(l => l.startsWith("-") && !l.startsWith("---"))).toEqual([]);
  });
});

describe("Start im Container (container/start.sh)", () => {
  test("ohne Marke der Firewall startet Asterisk nicht", () => {
    const r = Bun.spawnSync(["sh", join(DEPLOY, "container", "start.sh")], { env: { PATH: "/usr/bin:/bin", FIREWALL_MARKE: "/nicht/vorhanden/geladen" } });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("Firewall der Vermittlung seit dem Systemstart nicht geladen");
  });

  test("compose startet über start.sh, mit Marke aus /run und UTC", () => {
    const compose = readFileSync(join(DEPLOY, "compose.yaml"), "utf8");
    expect(compose).toContain('command: ["/bin/sh", "/vermittlung/start.sh"]');
    expect(compose).toContain("- /run/sip-vermittlung:/firewall:ro");
    expect(compose).toContain("- ./container:/vermittlung:ro");
    expect(compose).toContain("TZ: UTC");
    expect(readFileSync(join(DEPLOY, "fail2ban", "sip-vermittlung.local"), "utf8")).toMatch(/^logtimezone = UTC$/m);
  });
});

describe("Firewall über Neustarts (firewall.sh, systemd)", () => {
  /** firewall.sh mit Attrappen für nft und getent; Rückgabe: Exit, Marke vorhanden, Aufrufe von nft */
  function run(nftExit: number): { code: number; marker: boolean; calls: string } {
    const dir = mkdtempSync(join(tmpdir(), "sipv-fw-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      mkdirSync(join(dir, "erzeugt"));
      writeFileSync(join(dir, "erzeugt", "firewall.nft"), "table inet sip_vermittlung {}\n");
      writeFileSync(join(bin, "nft"), `#!/bin/sh\necho "$*" >> "${dir}/aufrufe"\nexit ${nftExit}\n`);
      writeFileSync(join(bin, "getent"), "#!/bin/sh\nexit 2\n");
      chmodSync(join(bin, "nft"), 0o755);
      chmodSync(join(bin, "getent"), 0o755);
      writeFileSync(join(dir, "firewall.sh"), readFileSync(join(DEPLOY, "firewall.sh")));
      const r = Bun.spawnSync(["sh", join(dir, "firewall.sh")], { env: { PATH: `${bin}:/usr/bin:/bin`, FIREWALL_MARKE: join(dir, "run", "geladen") } });
      return { code: r.exitCode, marker: existsSync(join(dir, "run", "geladen")), calls: existsSync(join(dir, "aufrufe")) ? readFileSync(join(dir, "aufrufe"), "utf8") : "" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("Marke erst nach erfolgreichem Laden, nicht bei Fehler", () => {
    const ok = run(0);
    expect(ok.code).toBe(0);
    expect(ok.marker).toBe(true);
    expect(ok.calls).toContain("-f ");
    const failed = run(1);
    expect(failed.code).not.toBe(0);
    expect(failed.marker).toBe(false);
  });

  test("die Unit lädt die Firewall bei jedem Start vor Docker und nach nftables", () => {
    const unit = readFileSync(join(DEPLOY, "systemd", "sip-vermittlung-firewall.service"), "utf8");
    expect(unit).toMatch(/^Before=docker\.service$/m);
    expect(unit).toMatch(/^After=network-online\.target nftables\.service$/m);
    expect(unit).toMatch(/^PartOf=nftables\.service$/m);
    expect(unit).toMatch(/^Type=oneshot$/m);
    expect(unit).toMatch(/^RemainAfterExit=yes$/m);
    expect(unit).toMatch(/^ExecStart=\/docker\/sip-vermittlung\/firewall\.sh$/m);
    expect(unit).toMatch(/^WantedBy=multi-user\.target docker\.service$/m);
  });
});

describe("Zertifikat (zertifikat-erneuern.sh)", () => {
  /**
   * Zustand, den die docker-Attrappe meldet: "fehlt" (kein Container, nur
   * ähnlich benannte), "gestoppt", "laeuft", "gespraech" (läuft mit einem
   * Gespräch) oder ein Abfragefehler: docker ps oder inspect scheitern,
   * inspect liefert keinen Zustand, group show channels scheitert oder ist
   * unlesbar.
   */
  type Container = "fehlt" | "gestoppt" | "laeuft" | "gespraech" | "ps_fehler" | "inspect_fehler" | "inspect_unlesbar" | "exec_fehler" | "exec_unlesbar";

  /** Skript in einem Wegwerf-Ordner mit docker-Attrappe; die Attrappe schreibt jeden Neustart nach neustarts */
  function setup(): { dir: string; source: string; run: (container: Container) => { code: number; out: string; restarts: number } } {
    const dir = mkdtempSync(join(tmpdir(), "sipv-zert-"));
    const source = join(dir, "quelle");
    mkdirSync(source);
    writeFileSync(join(source, "fullchain.pem"), "zertifikat-1\n");
    writeFileSync(join(source, "privkey.pem"), "schluessel-1\n");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(dir, "zertifikat-erneuern.sh"), readFileSync(join(DEPLOY, "zertifikat-erneuern.sh")));
    const owner = `${process.getuid!()}:${process.getgid!()}`;
    const run = (container: Container) => {
      writeFileSync(join(bin, "docker"), `#!/bin/sh
Z=${container}
case "$1" in
ps)
  [ "$Z" = ps_fehler ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
  printf 'andere\\nsip-vermittlung-alt\\n'
  [ "$Z" = fehlt ] || echo sip-vermittlung ;;
inspect)
  case "$Z" in
  fehlt|inspect_fehler) echo "Error response from daemon" >&2; exit 1 ;;
  inspect_unlesbar) echo "" ;;
  gestoppt) echo false ;;
  *) echo true ;;
  esac ;;
exec)
  case "$Z" in
  gespraech) printf 'Channel   Group   Category\\nPJSIP/x   gespraech   vermittlung\\n1 active channel\\n' ;;
  exec_fehler) echo "Error response from daemon" >&2; exit 1 ;;
  exec_unlesbar) echo "Unable to connect to remote asterisk" ;;
  *) printf 'Channel   Group   Category\\n0 active channels\\n' ;;
  esac ;;
restart) echo x >> "${dir}/neustarts" ;;
esac
`);
      chmodSync(join(bin, "docker"), 0o755);
      const r = Bun.spawnSync(["sh", join(dir, "zertifikat-erneuern.sh"), source], { env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, ZERTIFIKAT_BESITZER: owner } });
      const restarts = existsSync(join(dir, "neustarts")) ? readFileSync(join(dir, "neustarts"), "utf8").trim().split("\n").length : 0;
      return { code: r.exitCode, out: `${r.stdout}${r.stderr}`, restarts };
    };
    return { dir, source, run };
  }
  const key = (dir: string) => join(dir, "zertifikat", "privkey.pem");
  const pending = (dir: string) => existsSync(join(dir, "zertifikat", ".neustart-offen"));

  test("Ersteinrichtung vor dem ersten Start: kopiert, Schlüssel 0640, kein Neustart, nichts offen", () => {
    const { dir, run } = setup();
    try {
      const r = run("fehlt");
      expect(r.code).toBe(0);
      expect(r.restarts).toBe(0);
      expect(readFileSync(join(dir, "zertifikat", "fullchain.pem"), "utf8")).toBe("zertifikat-1\n");
      expect(readFileSync(key(dir), "utf8")).toBe("schluessel-1\n");
      expect(statSync(key(dir)).mode & 0o777).toBe(0o640);
      expect(pending(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fehlender Zielschlüssel bei gleichem Zertifikat wird nachgeholt, falsche Rechte korrigiert", () => {
    const { dir, run } = setup();
    try {
      run("fehlt");
      rmSync(key(dir));
      expect(run("fehlt").code).toBe(0);
      expect(readFileSync(key(dir), "utf8")).toBe("schluessel-1\n");
      chmodSync(key(dir), 0o644);
      expect(run("fehlt").code).toBe(0);
      expect(statSync(key(dir)).mode & 0o777).toBe(0o640);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unverändertes Zertifikat bei laufendem Asterisk: kein Neustart", () => {
    const { dir, run } = setup();
    try {
      run("fehlt");
      const r = run("laeuft");
      expect(r.code).toBe(0);
      expect(r.restarts).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("neues Zertifikat während eines Gesprächs: Neustart verschoben und beim nächsten freien Lauf nachgeholt", () => {
    const { dir, source, run } = setup();
    try {
      run("fehlt");
      writeFileSync(join(source, "fullchain.pem"), "zertifikat-2\n");
      writeFileSync(join(source, "privkey.pem"), "schluessel-2\n");
      const busy = run("gespraech");
      expect(busy.out).toContain("Neustart verschoben");
      expect(busy.restarts).toBe(0);
      expect(pending(dir)).toBe(true);
      expect(readFileSync(key(dir), "utf8")).toBe("schluessel-2\n");
      // Quelle unverändert, aber der Neustart steht noch aus
      const free = run("laeuft");
      expect(free.restarts).toBe(1);
      expect(pending(dir)).toBe(false);
      expect(run("laeuft").restarts).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gestoppter Container: Marke erledigt, kein Neustart", () => {
    const { dir, source, run } = setup();
    try {
      run("fehlt");
      writeFileSync(join(source, "fullchain.pem"), "zertifikat-2\n");
      const r = run("gestoppt");
      expect(r.code).toBe(0);
      expect(r.restarts).toBe(0);
      expect(pending(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Abfragefehler oder unlesbare Antwort: Marke bleibt, kein Neustart, Fehler gemeldet; der nächste gültige Lauf holt ihn nach", () => {
    for (const failure of ["ps_fehler", "inspect_fehler", "inspect_unlesbar", "exec_fehler", "exec_unlesbar"] as const) {
      const { dir, source, run } = setup();
      try {
        run("fehlt");
        writeFileSync(join(source, "fullchain.pem"), "zertifikat-2\n");
        const r = run(failure);
        expect({ failure, code: r.code, restarts: r.restarts, pending: pending(dir) }).toEqual({ failure, code: 1, restarts: 0, pending: true });
        expect(r.out).toContain("Neustart bleibt offen, Zustand von Asterisk unbekannt");
        // Zertifikat ist trotzdem übernommen
        expect(readFileSync(join(dir, "zertifikat", "fullchain.pem"), "utf8")).toBe("zertifikat-2\n");
        const ok = run("laeuft");
        expect(ok.code).toBe(0);
        expect(ok.restarts).toBe(1);
        expect(pending(dir)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("ohne Quelle bricht das Skript ab", () => {
    const { dir, source, run } = setup();
    try {
      rmSync(join(source, "privkey.pem"));
      expect(run("fehlt").code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Generator: URIs für Asterisk", () => {
  test("Semikolons in URIs werden geschützt, schon geschützte bleiben", () => {
    expect(confUri("sip:a:5061;transport=tls")).toBe(String.raw`sip:a:5061\;transport=tls`);
    expect(confUri(String.raw`sip:a:5061\;transport=tls`)).toBe(String.raw`sip:a:5061\;transport=tls`);
    expect(confUri("sip:a:5060")).toBe("sip:a:5060");
  });
});

describe("Schreiben der Dateien", () => {
  test("pjsip.conf mit Zugangsdaten nur für Besitzer und Gruppe, Ersatz erst nach vollständigem Schreiben", () => {
    const dir = mkdtempSync(join(tmpdir(), "sipv-"));
    try {
      const out = join(dir, "erzeugt");
      mkdirSync(out);
      writeFileSync(join(out, "alt.txt"), "alt");
      writeRendered(render(), out);
      expect(existsSync(join(out, "alt.txt"))).toBe(false);
      expect(statSync(join(out, "asterisk", "pjsip.conf")).mode & 0o777).toBe(0o640);
      expect(statSync(join(out, "asterisk", "rtp.conf")).mode & 0o777).toBe(0o644);
      expect(existsSync(`${out}.neu`) || existsSync(`${out}.alt`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("render.ts bricht ohne gültige .env ab und lässt den alten Stand stehen", () => {
    const dir = mkdtempSync(join(tmpdir(), "sipv-"));
    try {
      writeFileSync(join(dir, ".env"), "EASYBELL_BENUTZER=x\n");
      mkdirSync(join(dir, "erzeugt"));
      writeFileSync(join(dir, "erzeugt", "alt.txt"), "alt");
      const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "deploy", "sip-vermittlung", "render.ts"), "--env", join(dir, ".env"), "--aus", join(dir, "erzeugt")]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain("EASYBELL_PASSWORT fehlt");
      expect(readFileSync(join(dir, "erzeugt", "alt.txt"), "utf8")).toBe("alt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("zustand.sh", () => {
  const script = join(import.meta.dir, "..", "deploy", "sip-vermittlung", "zustand.sh");

  /** Kopie des Skripts mit einer docker-Attrappe im PATH */
  function run(dockerScript: string, dir: string): Record<string, string> {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "docker"), `#!/bin/sh\n${dockerScript}\n`);
    chmodSync(join(bin, "docker"), 0o755);
    writeFileSync(join(dir, "zustand.sh"), readFileSync(script));
    chmodSync(join(dir, "zustand.sh"), 0o755);
    const r = Bun.spawnSync(["sh", join(dir, "zustand.sh")], { env: { PATH: `${bin}:/usr/bin:/bin` } });
    expect(r.exitCode).toBe(0);
    return Object.fromEntries(r.stdout.toString().trim().split("\n").map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  }

  const registrations = (status: string) => `case "$*" in
*registrations*) cat <<'X'

 <Registration/ServerURI..............................>  <Auth....................>  <Status.......>
==========================================================================================

 easybell-reg/sip:voip.easybell.de:5061                  easybell-auth               ${status}        (exp. 549s)

Objects found: 1
X
;;
*group*) printf 'Channel   Group   Category\\nPJSIP/x   gespraech   vermittlung\\n1 active channel\\n' ;;
esac`;

  test("registriert: Zustand, Zeitpunkt und Gespräche; danach Ausfall mit erhaltenem Zeitpunkt", () => {
    const dir = mkdtempSync(join(tmpdir(), "sipv-zustand-"));
    try {
      const ok = run(registrations("Registered"), dir);
      expect(ok.version).toBe("1");
      expect(ok.status).toBe("Registered");
      expect(ok.letzte_registrierung).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      expect(ok.letzte_registrierung).toBe(ok.zeit);
      expect(ok.gespraeche).toBe("1");

      const rejected = run(registrations("Rejected"), dir);
      expect(rejected.status).toBe("Rejected");
      expect(rejected.letzte_registrierung).toBe(ok.letzte_registrierung);

      const stopped = run("exit 1", dir);
      expect(stopped.status).toBe("gestoppt");
      expect(stopped.gespraeche).toBe("");
      expect(stopped.letzte_registrierung).toBe(ok.letzte_registrierung);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("nie registriert: leerer Zeitpunkt, fehlende Zeile heißt unbekannt", () => {
    const dir = mkdtempSync(join(tmpdir(), "sipv-zustand-"));
    try {
      const out = run("echo 'Objects found: 0'", dir);
      expect(out.status).toBe("unbekannt");
      expect(out.letzte_registrierung).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
