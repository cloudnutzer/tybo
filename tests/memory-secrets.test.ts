/**
 * Issue #524: Erkennung und Maskierung von Geheimnissen. Alle Werte sind erfunden
 * und zur Laufzeit zusammengesetzt, damit kein Prüfwerkzeug sie für echt hält.
 */
import { describe, expect, test } from "bun:test";
import { containsSecret, findSecrets, maskSecrets, SECRET_MASK } from "../src/lib/memory/secrets";
import { HARMLESS_FACTS, LABELED_SECRETS } from "./memory-secrets-cases";

const alnum = (length: number, seed = "Ab3dE6gH9k") => seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
const hex = (length: number) => "0123456789abcdef".repeat(Math.ceil(length / 16)).slice(0, length);

const PRIVATE_KEY = ["-----BEGIN RSA PRIVATE KEY-----", alnum(64), alnum(64), "-----END RSA PRIVATE KEY-----"].join("\n");

const KEYS: [string, string][] = [
  ["Anthropic", `sk-ant-${alnum(40)}`],
  ["OpenAI", `sk-proj-${alnum(40)}`],
  ["OpenRouter", `sk-or-v1-${hex(64)}`],
  ["ElevenLabs", `sk_${hex(48)}`],
  ["GitHub", `ghp_${alnum(36)}`],
  ["GitHub fein", `github_pat_${alnum(40)}`],
  ["GitLab", `glpat-${alnum(20)}`],
  ["Slack", `xoxb-1234567890-${alnum(24)}`],
  ["AWS", `AKIA${"ABCDEFGH23456789"}`],
  ["Google", `AIza${alnum(35)}`],
  ["Supabase", `sbp_${hex(40)}`],
  ["Groq", `gsk_${alnum(40)}`],
  ["Cloudflare", `cfat_${alnum(40)}`],
  ["Telegram", `123456789:${alnum(35)}`],
  ["JWT", `eyJ${alnum(20)}.eyJ${alnum(30)}.${alnum(30)}`],
];

describe("wird erkannt", () => {
  test.each(KEYS)("Schlüssel von %s, mitten im Satz", (_name, key) => {
    const text = `Der Zugang ist ${key} für das Projekt`;
    expect(findSecrets(text).map(span => span.kind)).toEqual(["schluessel"]);
    expect(maskSecrets(text)).toBe(`Der Zugang ist ${SECRET_MASK} für das Projekt`);
  });

  test("mehrzeiliger privater Schlüssel, ganz ersetzt", () => {
    expect(maskSecrets(`Vorher\n${PRIVATE_KEY}\nNachher`)).toBe(`Vorher\n${SECRET_MASK}\nNachher`);
  });

  test("abgeschnittener privater Schlüssel: alles ab dem Anfang fällt weg", () => {
    expect(maskSecrets(`Vorher ${PRIVATE_KEY.slice(0, 60)}`)).toBe(`Vorher ${SECRET_MASK}`);
  });

  test("Privater Schlüssel auf einer Zeile und PGP", () => {
    expect(maskSecrets(`A ${PRIVATE_KEY.replaceAll("\n", " ")} B`)).toBe(`A ${SECRET_MASK} B`);
    expect(containsSecret("-----BEGIN PGP PRIVATE KEY BLOCK-----\nabc")).toBe(true);
    expect(containsSecret("-----BEGIN OPENSSH PRIVATE KEY-----\nabc")).toBe(true);
  });

  test.each([
    ["Passwort: Waldgeheim42", `Passwort: ${SECRET_MASK}`],
    ["passwort=Waldmeister", `passwort=${SECRET_MASK}`],
    ["Das Passwort ist Waldgeheim42.", `Das Passwort ist ${SECRET_MASK}.`],
    ["Das Passwort lautet Waldmeister", `Das Passwort lautet ${SECRET_MASK}`],
    ["hinter Passwort Waldgeheim42 erreichbar", `hinter Passwort ${SECRET_MASK} erreichbar`],
    ["Seite imker.example (pw honig7788)", `Seite imker.example (pw ${SECRET_MASK})`],
    ["Seite imker.example, pw waldhonig", `Seite imker.example, pw ${SECRET_MASK}`],
    ["Seiten-Passwort: Waldgeheim42", `Seiten-Passwort: ${SECRET_MASK}`],
    ["Seitenpasswort: Waldgeheim42", `Seitenpasswort: ${SECRET_MASK}`],
    ["Passwort für die Seite imker.example: Waldmeister", `Passwort für die Seite imker.example: ${SECRET_MASK}`],
    ["Passwort für die Seite ist Waldgeheim42", `Passwort für die Seite ist ${SECRET_MASK}`],
    ['password is "two words"', `password is "${SECRET_MASK}"`],
    ["password is hunter2hunter", `password is ${SECRET_MASK}`],
    ["DB_PASSWORD=Waldgeheim42", `DB_PASSWORD=${SECRET_MASK}`],
    ["PIN: 4711", `PIN: ${SECRET_MASK}`],
    ["PIN 4711", `PIN ${SECRET_MASK}`],
  ])("Passwort: %s", (text, masked) => {
    expect(maskSecrets(text)).toBe(masked);
    expect(findSecrets(text).map(span => span.kind)).toEqual(["passwort"]);
  });

  test.each([
    [`Token: ${alnum(20)}`, `Token: ${SECRET_MASK}`],
    [`API-Key: ab12cd34`, `API-Key: ${SECRET_MASK}`],
    [`TELEGRAM_BOT_TOKEN=${alnum(20)}`, `TELEGRAM_BOT_TOKEN=${SECRET_MASK}`],
    [`client_secret: "${alnum(20)}"`, `client_secret: "${SECRET_MASK}"`],
    [`secret=${hex(40)}`, `secret=${SECRET_MASK}`],
    [`Schlüssel: ab12cd34ef`, `Schlüssel: ${SECRET_MASK}`],
    [`Authorization: Bearer ${alnum(30)}`, `Authorization: Bearer ${SECRET_MASK}`],
    ["postgres://alex:Waldgeheim42@db.example:5432/app", `postgres://alex:${SECRET_MASK}@db.example:5432/app`],
    [`lange Kette ${alnum(40)} im Text`, `lange Kette ${SECRET_MASK} im Text`],
  ])("Schlüssel mit Bezeichnung oder in Adresse: %s", (text, masked) => {
    expect(maskSecrets(text)).toBe(masked);
  });

  test("mehrere Geheimnisse in einem Text, Überlappung zählt einmal", () => {
    const key = `ghp_${alnum(36)}`;
    expect(maskSecrets(`Token: ${key} und Passwort: Waldgeheim42`)).toBe(`Token: ${SECRET_MASK} und Passwort: ${SECRET_MASK}`);
    expect(findSecrets(`Token: ${key}`)).toHaveLength(1);
  });

  test("maskieren ist wiederholbar, die Maske gilt nicht als Geheimnis", () => {
    for (const text of ["Passwort: Waldgeheim42", `Token: ${alnum(20)}`, PRIVATE_KEY, "pw honig7788"]) {
      const once = maskSecrets(text);
      expect(containsSecret(once)).toBe(false);
      expect(maskSecrets(once)).toBe(once);
    }
  });
});

describe("Variablen und Kopfzeilen", () => {
  test.each([
    ["GROQ_KEY=abcD1234geheim5678", `GROQ_KEY=${SECRET_MASK}`],
    ["STRIPE_KEY: Xy12geheim56", `STRIPE_KEY: ${SECRET_MASK}`],
    [`export MY_APP_KEY="Sommerwiese77"`, `export MY_APP_KEY="${SECRET_MASK}"`],
    ["Authorization: Basic dXNlcjpwYXNzd29yZA==", `Authorization: Basic ${SECRET_MASK}`],
    ["authorization: token abcd1234efgh", `authorization: token ${SECRET_MASK}`],
  ])("%s", (text, masked) => {
    expect(maskSecrets(text)).toBe(masked);
  });

  test.each(["primary_key: user_id_2", "sort_key = created_at_2024", "SORT_KEY: name", "PRIMARY_KEY: 12345", "Authorization: Basic ist hier nicht erlaubt", "Authorization ist Pflicht"])("frei: %s", text => {
    expect(maskSecrets(text)).toBe(text);
  });
});

describe("beschriftete Werte in jeder Schreibweise", () => {
  test.each(LABELED_SECRETS.map(({ text, masked, rest }) => [text, masked, rest] as const))("%s", (text, masked, rest) => {
    const result = maskSecrets(text);
    expect(result).toBe(masked);
    expect(containsSecret(text)).toBe(true);
    for (const part of rest) expect(result).not.toContain(part);
    expect(maskSecrets(result)).toBe(result);
  });

  test.each([
    ["Passwort `Waldgeheim42` ", `Passwort \`${SECRET_MASK}\` `],
    ["`Passwort`: Waldgeheim42", `\`Passwort\`: ${SECRET_MASK}`],
    ["`password=Waldgeheim42`", `\`password=${SECRET_MASK}\``],
    ["Passwort: ```Waldgeheim42```", `Passwort: \`\`\`${SECRET_MASK}\`\`\``],
    [`Token: \`${alnum(20)}\``, `Token: \`${SECRET_MASK}\``],
    [`GROQ_KEY=\`${alnum(20)}\``, `GROQ_KEY=\`${SECRET_MASK}\``],
  ])("Backticks: %s", (text, masked) => {
    expect(maskSecrets(text)).toBe(masked);
  });

  test.each(["~", "(", "$", "/", ".", "<", "[", "{", "•", "…"])("zitierter Wert beginnt mit %s: echter Wert, kein Platzhalter", first => {
    expect(maskSecrets(`Passwort: "${first}Waldgeheim42"`)).toBe(`Passwort: "${SECRET_MASK}"`);
    expect(maskSecrets(`Token: "${first}${alnum(20)}"`)).toBe(`Token: "${SECRET_MASK}"`);
  });

  test.each(["Authorization: bearer", "authorization: BEARER", "AUTHORIZATION: Bearer", "bearer", "BEARER"])("%s, kurz oder lang", prefix => {
    const value = hex(20);
    expect(maskSecrets(`${prefix} ${value}`)).toBe(`${prefix} ${SECRET_MASK}`);
  });

  test.each([
    ["[Passwort]: Waldgeheim42", `[Passwort]: ${SECRET_MASK}`],
    ["(Passwort): Waldgeheim42", `(Passwort): ${SECRET_MASK}`],
    ['Passwort: "12.10.2026"', `Passwort: "${SECRET_MASK}"`],
    ["PIN: 1111", `PIN: ${SECRET_MASK}`],
    ["Passwort: aaaaaa", `Passwort: ${SECRET_MASK}`],
    ['Passwort: "aaaaaa"', `Passwort: "${SECRET_MASK}"`],
    ["Passwort: $SOMMERWIESE77", `Passwort: ${SECRET_MASK}`],
    ["postgres://alex:<Waldgeheim42>@db.example/app", `postgres://alex:${SECRET_MASK}@db.example/app`],
    ["postgres://alex:[Waldgeheim42]@db.example/app", `postgres://alex:${SECRET_MASK}@db.example/app`],
    ["postgres://alex:Waldgeheim42.env@db.example/app", `postgres://alex:${SECRET_MASK}@db.example/app`],
  ])("sieht nur aus wie ein Stellvertreter: %s", (text, masked) => {
    expect(maskSecrets(text)).toBe(masked);
    expect(maskSecrets(masked)).toBe(masked);
  });

  test("Kopfzeile mit kurzem Wert in jeder Schreibung", () => {
    expect(maskSecrets("Authorization: bearer ab12cd34")).toBe(`Authorization: bearer ${SECRET_MASK}`);
  });

  test.each([
    [`Passwort: "Wald'geheim42"`, `Passwort: "${SECRET_MASK}"`],
    [`Passwort: 'Wald"geheim42'`, `Passwort: '${SECRET_MASK}'`],
    [`Passwort: 'Wald'geheim42'`, `Passwort: '${SECRET_MASK}'`],
    [`Passwort: \`Wald'geheim42\``, `Passwort: \`${SECRET_MASK}\``],
    [`Passwort: „Wald'geheim42“`, `Passwort: „${SECRET_MASK}“`],
    [`Passwort: »Wald"geheim42«`, `Passwort: »${SECRET_MASK}«`],
    [`Passwort: "Wald\\"geheim42"`, `Passwort: "${SECRET_MASK}"`],
    [`Passwort: "Wald geheim42`, `Passwort: "${SECRET_MASK}`],
    [`Passwort: "Wald geheim42'`, `Passwort: "${SECRET_MASK}`],
    [`Passwort: "Wald,geheim42", Nutzer alex`, `Passwort: "${SECRET_MASK}", Nutzer alex`],
    [`Passwort: "Waldgeheim42" und Token: "${alnum(20)}"`, `Passwort: "${SECRET_MASK}" und Token: "${SECRET_MASK}"`],
    [`{"password":"Wald'geheim42","user":"alex"}`, `{"password":"${SECRET_MASK}","user":"alex"}`],
    ...[",", ";", ")", "]", "}", "'", '"', "`", "<", ">"].map(mark => [`Passwort: Wald${mark}geheim42`, `Passwort: ${SECRET_MASK}`]),
    ["Passwort: Waldgeheim42!", `Passwort: ${SECRET_MASK}`],
    ["Das Passwort ist Wald,geheim42.", `Das Passwort ist ${SECRET_MASK}.`],
    ["(Passwort: Wald,geheim42)", `(Passwort: ${SECRET_MASK})`],
    ["Passwort: Wald,geheim42, Nutzer alex", `Passwort: ${SECRET_MASK}, Nutzer alex`],
    ["Passwort: Wald(geheim42)", `Passwort: ${SECRET_MASK}`],
    [`"Passwort: Waldgeheim42"`, `"Passwort: ${SECRET_MASK}"`],
    [`Token: ${alnum(10)},${alnum(10)}`, `Token: ${SECRET_MASK}`],
    [`GROQ_KEY=${alnum(10)};${alnum(10)}`, `GROQ_KEY=${SECRET_MASK}`],
    ["postgres://alex:*Waldgeheim42@db.example/app", `postgres://alex:${SECRET_MASK}@db.example/app`],
  ])("ganzer Wert fällt weg: %s", (text, masked) => {
    expect(maskSecrets(text)).toBe(masked);
    expect(maskSecrets(masked)).toBe(masked);
  });
});

describe("Strich und Tabelle: reine Wörter und ganze Zellen", () => {
  test.each([
    ["Passwort - Waldmeister", `Passwort - ${SECRET_MASK}`],
    ["**Passwort** - Waldmeister", `**Passwort** - ${SECRET_MASK}`],
    ["Passwort - Waldmeister.", `Passwort - ${SECRET_MASK}.`],
    ["Passwort - Waldmeister, Nutzer alex", `Passwort - ${SECRET_MASK}, Nutzer alex`],
    ["Seite imker - Passwort - Waldmeister - Nutzer alex", `Seite imker - Passwort - ${SECRET_MASK} - Nutzer alex`],
    ["Passwort - Waldmeister  \nNutzer alex", `Passwort - ${SECRET_MASK}  \nNutzer alex`],
    ["| Passwort | Waldmeister |", `| Passwort | ${SECRET_MASK} |`],
    ["| **Passwort** | Waldmeister |", `| **Passwort** | ${SECRET_MASK} |`],
    ["Imkerei: | Passwort | Waldmeister |", `Imkerei: | Passwort | ${SECRET_MASK} |`],
    ["| PIN | 4711 |", `| PIN | ${SECRET_MASK} |`],
    ["| Passwort | Sommer wiese77 |", `| Passwort | ${SECRET_MASK} |`],
    ["| Passwort | Sommer\\|wiese77 |", `| Passwort | ${SECRET_MASK} |`],
    ["| Passwort | Sommer|wiese77 |", `| Passwort | ${SECRET_MASK} |`],
    ["| Passwort | Sommer wiese77 |\n|---|---|", `| Passwort | ${SECRET_MASK} |\n|---|---|`],
    ["steht als Passwort | Sommerwiese77 schon da", `steht als Passwort | ${SECRET_MASK}`],
    ["steht als |Passwort|Sommerwiese77| schon da", `steht als |Passwort|${SECRET_MASK}| schon da`],
    ["| Authorization | Basic dXNlcjpwYXNz |", `| Authorization | ${SECRET_MASK} |`],
    ["| Authorization | Bearer abcdef1234567890abcd |", `| Authorization | ${SECRET_MASK} |`],
  ])("%s", (text, masked) => {
    expect(maskSecrets(text)).toBe(masked);
    expect(containsSecret(text)).toBe(true);
    expect(maskSecrets(masked)).toBe(masked);
  });

  test.each([
    ["| Nutzer | Passwort |\n|---|---|\n| alex | Sommerwiese77 |\n| mia | Waldmeister |", `| Nutzer | Passwort |\n|---|---|\n| alex | ${SECRET_MASK} |\n| mia | ${SECRET_MASK} |`],
    ["| Passwort | Nutzer |\n| --- | --- |\n| Sommerwiese77 | alex |", `| Passwort | Nutzer |\n| --- | --- |\n| ${SECRET_MASK} | alex |`],
    ["| **Passwort** |\n|:---:|\n| Sommerwiese77 |", `| **Passwort** |\n|:---:|\n| ${SECRET_MASK} |`],
    ["Imkerei: | Nutzer | API-Key |\n|---|---|\n| alex | ab12cd34ef56 |", `Imkerei: | Nutzer | API-Key |\n|---|---|\n| alex | ${SECRET_MASK} |`],
    // Der Wert steht schon neben der Bezeichnung: Die erste Zeile ist ein Eintrag, die Zeile darunter bleibt
    ["| Passwort | Sommerwiese77 |\n|---|---|\n| Nutzer | alex |", `| Passwort | ${SECRET_MASK} |\n|---|---|\n| Nutzer | alex |`],
    // Eine Leerzeile beendet die Tabelle
    ["| Passwort |\n|---|\n| Sommerwiese77 |\n\n| Sommerzeit |", `| Passwort |\n|---|\n| ${SECRET_MASK} |\n\n| Sommerzeit |`],
  ])("Spalte unter der Bezeichnung: %s", (text, masked) => {
    expect(maskSecrets(text)).toBe(masked);
    expect(maskSecrets(masked)).toBe(masked);
  });
});

describe("Anbieter-Schlüssel in Unterstrichen", () => {
  const key = `ghp_${alnum(40)}`;

  test("die Gegenprobe aus der Prüfung", () => {
    expect(containsSecret(key)).toBe(true);
    expect(containsSecret(`_${key}_`)).toBe(true);
    expect(maskSecrets(`_${key}_`)).toBe(SECRET_MASK);
  });

  test.each(KEYS)("%s, in Unterstrichen mitten im Satz", (_name, value) => {
    expect(maskSecrets(`Der Zugang ist _${value}_ für das Projekt`)).toBe(`Der Zugang ist ${SECRET_MASK} für das Projekt`);
    expect(maskSecrets(`Der Zugang ist __${value}__.`)).toBe(`Der Zugang ist ${SECRET_MASK}.`);
  });

  test("ein Unterstrich als letztes Zeichen des Schlüssels fällt mit weg", () => {
    expect(maskSecrets(`sk_${alnum(30)}_`)).toBe(SECRET_MASK);
    expect(maskSecrets(`_sk_${alnum(30)}__`)).toBe(SECRET_MASK);
  });
});

describe("kein Fehlalarm", () => {
  test.each(HARMLESS_FACTS)("Pfad, Hash, Verweis oder Maske: %s", text => {
    expect(findSecrets(text)).toEqual([]);
    expect(maskSecrets(text)).toBe(text);
  });

  test.each([
    "Bestellnummer 1234567890",
    "Alex wurde 1984 geboren, Telefon +49 170 1234567",
    "Budget 1500000 Euro, 42 Prozent",
    `Commit ${hex(40)} ist der letzte Stand`,
    `Commit ${hex(7)} und ${hex(12)}`,
    `git checkout ${hex(40).toUpperCase()}`,
    `SHA-256: ${hex(64)}`,
    `sha256:${hex(64)}`,
    "Kennung 3f2b8c1e-9d4a-4c7b-8e21-5a6f7d8e9c01",
    "/Users/alex/.ssh/id_rsa ist der Pfad",
    "~/.config/tybo/token.json",
    `/var/lib/app/${alnum(40)}/daten.bin`,
    `https://imker.example/bilder/${alnum(40)}/honig.png`,
    `docs/${alnum(40)}.md`,
    "src/lib/memory/secrets.ts",
    "https://imker.example:8443/start",
    "Der Schlüssel liegt unter der Matte",
    "Schlüssel: unter der Matte",
    "Passwort vergessen",
    "Passwort zurücksetzen unter https://imker.example/reset",
    "Das Passwort ist abgelaufen",
    "Das Passwort ist vergessen",
    "Das Passwort steht in der .env",
    "Passwort: siehe .env",
    "Passwort: gesetzt",
    "Passwort für den Server liegt im Tresor",
    "Passwort-Manager: Bitwarden",
    "Passwortmanager ist Bitwarden",
    "password policy v2 gilt",
    "password: string",
    "Passwort 12.10.2026 geändert",
    "Passwort mind. 12 Zeichen",
    "Tokens: 1500",
    "max_tokens: 4096",
    "Token-Limit 200000",
    "Token: abgelaufen",
    "secret: true",
    "pw zurücksetzen",
    "PIN: 3",
    "Pin: Berlin",
    "PW 200",
    "sk-learn-tutorial-for-beginners-and-more",
    "task-abcdefghijklmnopqrstuvwxyz",
    "Port 3100, Version 2.16.0, Datum 2026-10-31",
    "12:30 Uhr Termin",
    "Alex trinkt morgens Tee",
    `Passwort: ${SECRET_MASK}`,
    "postgres://alex:<passwort>@db.example/app",
    "postgres://localhost:5432/app",
    'Passwort: "<dein passwort>"',
    "Passwort: <dein passwort>",
    'Passwort: "${DB_PASS}"',
    "Passwort: ${DB_PASS}",
    "Passwort: $DB_PASS",
    "Passwort: {{ vault.pw }}",
    "Passwort: (siehe Tresor)",
    'Passwort: "***"',
    "Passwort: ***",
    "Passwort: `***`",
    "Passwort: `<wert>`",
    "Passwort: `.env`",
    `Passwort: "${SECRET_MASK}"`,
    `Passwort: \`${SECRET_MASK}\``,
    `Passwort: ${SECRET_MASK}, Nutzer alex`,
    'Passwort: ""',
    'Passwort: "",',
    "Passwort: ...",
    "Passwort vergessen!",
    "Passwort vergessen?",
    "Passwort: gesetzt!",
    "Passwort **vergessen**",
    "Passwort: **gesetzt**",
    "Token: **gesetzt**",
    "Passwort: C:\\Users\\alex\\pw.txt",
    "Token: C:\\Users\\alex\\token.json",
    "Passwort: ~/.secrets/pw.txt",
    "Passwort: /etc/app/pw",
    "Passwort: ./pw.txt",
    "PW 200,5",
    "PW 12.5",
    '{"password": null}',
    "password: string,",
    "bearer authentication-required",
    "Bearer-Token läuft ab",
    "| Passwort | Beschreibung |\n|---|---|",
    "| Name | Passwort | Rolle |\n|---|---|---|\n| alex | gesetzt | admin |",
    "| Name | Token |\n|---|---|\n| alex | 1500 |",
    "| Nutzer | Passwort |\n|---|---|\n| alex | im Tresor |\n| mia | noch nicht gesetzt |",
    "| Passwort | Letzte Änderung |\n|---|---|",
    "| Nutzer | Passwort | Letzte Änderung |\n|---|---|---|\n| alex | gesetzt | vor zwei Tagen |",
    "| Name | Token |\n|---|---|\n| alex | zwei Wochen gültig |",
  ])("%s", text => {
    expect(findSecrets(text)).toEqual([]);
    expect(maskSecrets(text)).toBe(text);
  });
});

/**
 * Grenze und Versuche für die Laufzeit. Eine einzelne Messung sagt auf einem ausgelasteten
 * Rechner nichts: Im Gesamtlauf brauchten Fälle mit isoliert 35 ms bei Last 30 bis zu 2500 ms.
 * Darum zählt der schnellste Versuch, vor jeder Wiederholung räumt der Speicher auf. Ein Muster
 * mit quadratischer Laufzeit braucht bei 200.000 Zeichen in jedem Versuch Sekunden und fällt
 * weiter auf.
 */
const RUNTIME_LIMIT_MS = 1000;
const RUNTIME_ATTEMPTS = 5;

function fastestRun(run: () => void, limitMs = RUNTIME_LIMIT_MS): number {
  let fastest = Infinity;
  for (let attempt = 0; attempt < RUNTIME_ATTEMPTS && fastest >= limitMs; attempt++) {
    if (attempt > 0) Bun.gc(true);
    const started = performance.now();
    run();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
}

describe("Runde 8: hinter der Bezeichnung nichts, der Wert steht darunter", () => {
  const VALUE = ["Birke", "Wolke77"].join("");
  test.each([
    [`Passwort\nbirke wolke`, `Passwort\n${SECRET_MASK}`],
    [`Passwort\n${VALUE}`, `Passwort\n${SECRET_MASK}`],
    [`Passwort\nBirke=1`, `Passwort\n${SECRET_MASK}`],
    [`## Passwort\nbirke wolke\n\nNächster Absatz`, `## Passwort\n${SECRET_MASK}\n\nNächster Absatz`],
    [`- **Passwort**\n  birke wolke`, `- **Passwort**\n  ${SECRET_MASK}`],
    [`Imkerei: Passwort\nbirke wolke`, `Imkerei: Passwort\n${SECRET_MASK}`],
    [`Passwort\n\`\`\`\nbun run passwd\n\`\`\``, `Passwort\n\`\`\`${SECRET_MASK}\`\`\``],
    [`Passwort\n<pre>\nbirke wolke\n</pre>`, `Passwort\n<pre>${SECRET_MASK}</pre>`],
  ])("die Bezeichnung allein auf ihrer Zeile nennt den Block darunter: %s", (text, masked) => {
    expect(maskSecrets(text)).toBe(masked);
    expect(maskSecrets(masked)).toBe(masked);
  });

  test.each([
    "Hinweise zum Passwort\nbirke wolke",
    "Hinweise zum Passwort\n```\nbun run passwd\n```",
    "Token\nDie Abrechnung läuft über Tokens.",
    "Thema: Passwort\nWir besprechen das morgen.",
    "Passwort\nvergessen",
    "Passwort\nsiehe Tresor",
  ])("davor ein Satz oder darunter ein Satz, Verweis oder Zustand: frei: %s", text => {
    expect(containsSecret(text)).toBe(false);
  });

  test("ein Wert über Zeilen fällt ganz weg, die nächste Zeile auf gleicher Ebene bleibt", () => {
    expect(maskSecrets(`db:\n  password: |\n    ${VALUE}\n    zweite\n  host: imker.example`)).toBe(`db:\n  password: |\n    ${SECRET_MASK}\n  host: imker.example`);
    expect(maskSecrets(`Passwort: ${VALUE}\n  zweite Zeile\nNutzer alex`)).toBe(`Passwort: ${SECRET_MASK}\nNutzer alex`);
    expect(maskSecrets(`Passwort: "${VALUE}"\n  zweite Zeile`)).toBe(`Passwort: "${SECRET_MASK}"\n  zweite Zeile`);
    expect(maskSecrets(`Passwort: <b>Birke\n${VALUE}</b>`)).toBe(`Passwort: <b>${SECRET_MASK}</b>`);
  });
});

describe("lange Texte", () => {
  test.each([
    ["ein langes Wort", "x".repeat(200_000)],
    ["Ziffern", "1".repeat(200_000)],
    ["Trenner", "a-b.".repeat(50_000)],
    ["viele Bezeichnungen", "Passwort ".repeat(20_000)],
    ["viele Anfänge", "sk-".repeat(60_000)],
    ["Adressen ohne Ende", "a://b:".repeat(30_000)],
    ["offener privater Schlüssel, oft", "-----BEGIN PRIVATE KEY-----\n".repeat(2_000)],
    ["viele Werte ohne Leerraum", "Passwort:".repeat(20_000)],
    ["viele offene Anführungszeichen", 'Passwort: "'.repeat(20_000)],
    ["viele offene Backticks", "Passwort: `".repeat(20_000)],
    ["Anführungszeichen ohne passendes Ende", 'Passwort: "a"x '.repeat(14_000)],
    ["viele Zeilen mit offenem Wert", 'Token: "abc\n'.repeat(16_000)],
    ["schließende Klammern am Ende", `Passwort: a${")".repeat(200_000)}`],
    ["Satzzeichen am Ende", `Passwort: a${".".repeat(200_000)}`],
    ["Hervorhebung mitten im Wert", `Passwort: a${"*".repeat(200_000)}a`],
    ["nur Hervorhebung", `Passwort: ${"*".repeat(200_000)}`],
    ["offene Klammern", "Passwort: <".repeat(20_000)],
    ["viele Bezeichnungen mit Hervorhebung", "**Passwort:** ".repeat(15_000)],
    ["Hervorhebung vor offenen Anführungszeichen", '**Passwort:** **"'.repeat(12_000)],
    ["Hervorhebung ohne Trenner", "Passwort**".repeat(20_000)],
    ["viele Tags hinter der Bezeichnung", "Passwort</b>".repeat(16_000)],
    ["viele Klammern als Wert", "Passwort: (a) ".repeat(14_000)],
    ["viele Schlüssel-Bezeichnungen mit Hervorhebung", "**API-Key:** ".repeat(15_000)],
    ["viele Variablen mit Hervorhebung", "__A_KEY__: ".repeat(18_000)],
    ["viele Kopfzeilen mit Hervorhebung", "**Authorization:** **Bearer** ".repeat(6_000)],
    ["viele Striche", "Passwort - ".repeat(18_000)],
    ["viele Striche ohne Wert", "- ".repeat(100_000)],
    ["viele Schlüssel-Bezeichnungen mit Strich", "**Token** - ".repeat(16_000)],
    ["viele senkrechte Striche", "|".repeat(200_000)],
    ["viele Zellen mit Bezeichnung", "| Passwort ".repeat(20_000)],
    ["viele Zellen mit Bezeichnung und Doppelpunkt", "| Passwort: ".repeat(18_000)],
    ["viele Paare in einer Zeile", "| Passwort | Wald77 ".repeat(10_000)],
    ["viele Zeilen mit Strich", "|\n".repeat(100_000)],
    ["viele Tabellenzeilen", "| Passwort | Wald77 |\n".repeat(9_000)],
    ["viele Kopf- und Trennzeilen", "| Passwort |\n|---|\n".repeat(10_000)],
    ["Variable ohne Ende in einer Zelle", `| ${"A".repeat(200_000)} |`],
    ["Leerraum in einer Zelle", `| Passwort${" ".repeat(200_000)}x |`],
    ["viele Unterstriche", "_".repeat(200_000)],
    ["viele Anfänge in Unterstrichen", "_sk-".repeat(50_000)],
    ["viele Bearer in Unterstrichen", "_Bearer ".repeat(25_000)],
    ["Unterstriche vor Bearer", `${"_".repeat(200_000)}Bearer x`],
    ["viele Wörter in einer Zelle", `| Passwort | ${"Wiese ".repeat(33_000)}|`],
    ["viele Ziffern in einer Zelle", `| Passwort | ${"1".repeat(200_000)} x |`],
    ["viele Zahlen in einer Zelle", `| Passwort | ${"1 ".repeat(100_000)}|`],
    ["viele Passphrasen in Zeilen", "| Passwort | Sommer Wiese |\n".repeat(7_000)],
    ["viele Passphrasen in einer Spalte", `| Nutzer | Passwort |\n|---|---|\n${"| alex | Sommer Wiese |\n".repeat(8_000)}`],
    ["viele Hervorhebungen an Wörtern", "_a ".repeat(66_000)],
    ["viele Sterne an Wörtern", "**a** ".repeat(33_000)],
    ["viele Tags", "<b>a</b>".repeat(25_000)],
    ["Passphrasen ohne Ende", "Passwort: a b c d e f g ".repeat(8_000)],
    ["lange Passphrase", `Passwort: ${"Wiese ".repeat(33_000)}`],
    ["viele PINs in Gruppen", "PIN 12 34 56 78 90 12 ".repeat(9_000)],
    ["viele Zifferngruppen", `PIN ${"1 ".repeat(100_000)}`],
    ["viele zusammengezogene Tabellen", "| a | Passwort | |---|---| | b | c | ".repeat(5_000)],
    ["viele Trennzeichen ohne Ende", "|-".repeat(100_000)],
    ["lange Trennlinie", `|${"-".repeat(200_000)}`],
    ["viele Trennlinien ohne Abschluss", `${"|---x".repeat(40_000)}`],
    ["viele Zeilengrenzen", `|---|\n| ${"| ".repeat(100_000)}`],
    ["viele Schlüssel-Bezeichnungen ohne Trenner", "Token ".repeat(30_000)],
    ["viele Einschübe", "Token für a b c ".repeat(12_000)],
    ["viele Paare", "Login: a / ".repeat(18_000)],
    ["lange Namen im Paar", `Login: ${"a".repeat(200_000)} / b`],
    ["viele Kopfzeilen ohne Wert", "Authorization: ".repeat(13_000)],
    ["lange Beschreibung ohne Wert", `Passwort: ${"Wiese ".repeat(33_000)}gesetzt`],
    ["viele Passphrasen mit Bindewort", "Passwort: a und b oder ".repeat(8_000)],
    ["Bindewörter ohne Ende", `Passwort: a ${"und ".repeat(50_000)}`],
    ["viele lange Passphrasen in Zeilen", `Passwort: ${"Wiese ".repeat(50)}\n`.repeat(600)],
    ["viele Ketten hinter einem Schlüssel", `Token: ${"ab12cd34 ".repeat(22_000)}`],
    ["viele Paare mit Passphrase", "Login: a / b c d ".repeat(11_000)],
    ["viele Paare in Anführungszeichen", 'Login: a / "'.repeat(16_000)],
    ["viele Bearer in Anführungszeichen", 'Bearer "'.repeat(25_000)],
    ["viele Kopfzeilen in Anführungszeichen", 'Authorization: Bearer "'.repeat(8_000)],
    ["viele Verfahren ohne Wert", "Authorization: Basic ".repeat(9_000)],
    ["viele Verfahren in Anführungszeichen", `Authorization: ${'"Basic" '.repeat(25_000)}`],
    ["lange Liste", `Passwort: ${"a, ".repeat(66_000)}`],
    ["lange Liste ohne Abschluss", `Passwort: ${"a, ".repeat(66_000)}x y`],
    ["viele Listen", "Passwort: a, b c\n".repeat(11_000)],
    ["viele Listen in einer Zeile", "Passwort: a, ".repeat(15_000)],
    ["lange Liste von Zahlen", `PIN: ${"1, ".repeat(66_000)}`],
    ["viele PINs mit Komma", "PIN 1, x ".repeat(22_000)],
    ["viele Pfade mit Bezeichnung", "/Users/Passwort x/".repeat(11_000)],
    ["viele Bezeichnungen in Pfaden", "/a/Passwort Backup2026/b.txt ".repeat(7_000)],
    ["viele Trenner", "/".repeat(200_000)],
    ["viele Backslashes", "\\".repeat(200_000)],
    ["viele Ordner", "a/".repeat(100_000)],
    ["viele Ordner mit Leerzeichen", "a b/".repeat(50_000)],
    ["viele Wörter ohne Trenner hinter einem Pfad", `/a ${"b ".repeat(100_000)}`],
    ["viele Pfade ohne Abschluss", "/a b ".repeat(40_000)],
    ["viele kurze Pfadanfänge", "a/ ".repeat(66_000)],
    ["langes Wort hinter einem Pfad", `/a ${"b".repeat(200_000)}`],
    ["langer Name im Pfad", `/${"a".repeat(200_000)}/b`],
    ["viele Bezeichnungen hinter einem Pfad", `/a/${"Passwort ".repeat(20_000)}`],
    ["viele abgelehnte lange Werte", `${"Passwort $A ".repeat(16_000)}`],
    ["abgelehnter langer Wert, oft", `Passwort ${"/a".repeat(100_000)}`],
    ["viele Zeilen ohne passendes Ende", 'Passwort: "a"x\n'.repeat(14_000)],
    ["viele Verweise ohne Ende", 'Passwort: "siehe Tresor\n'.repeat(8_000)],
    ["viele Verweise, am Ende ein schließendes Zeichen", `${'Passwort: "siehe Tresor\n'.repeat(8_000)}"`],
    ["viele offene Absätze unter einer Bezeichnung", 'Passwort\n"Ein Absatz.\n'.repeat(9_000)],
    ["ein schließendes Zeichen hinter viel Leerraum", `${'Passwort\n"a\n'.repeat(9_000)}${" ".repeat(100_000)}"`],
    ["viele Codeblöcke unter einer Bezeichnung", "Passwort\n```\nbun run check\n```\n".repeat(5_000)],
    ["viele offene Codeblöcke", "Passwort: ```\n".repeat(14_000)],
    ["langer Codeblock mit vielen Bezeichnungen", `Passwort\n\`\`\`\n${"Passwort: x y.\n".repeat(14_000)}\`\`\``],
    ["viele offene Anführungszeichen in Zellen", '| Passwort | "a\n'.repeat(11_000)],
    ["viele Zeilen in einfachen Anführungszeichen", "Token: 'ab cd\n".repeat(14_000)],
    ["viele Tilden", "~~~\n".repeat(50_000)],
    ["lange Parameterliste", `Authorization: Digest ${'a="b", '.repeat(30_000)}`],
    ["Parameterliste über viele Zeilen", `Authorization: Digest ${'a="b",\n'.repeat(24_000)}`],
    ["viele Kopfzeilen über Zeilen ohne Wert", "Authorization: x,\n".repeat(11_000)],
    ["viele Kopfzeilen ohne Wert mit Wörtern", "Authorization: x y ".repeat(10_000)],
    ["viele Kopfzeilen in Zeilen", 'Authorization: Digest a="b", c="d"\n'.repeat(5_500)],
    // Runde 8: Werte unter der Bezeichnung, HTML und Klammern über Zeilen
    ["viele Bezeichnungen mit Wert darunter", "Passwort:\n".repeat(20_000)],
    ["viele YAML-Blöcke", "password: |\n".repeat(16_000)],
    ["YAML-Block mit vielen Zeilen", `password: |\n${"  a\n".repeat(50_000)}`],
    ["viele YAML-Blöcke mit Verweis", "password: |\n  $A\n".repeat(12_000)],
    ["viele eingerückte Verweise", "Passwort:\n  siehe Tresor\n".repeat(8_000)],
    ["viele Zitatzeilen", `Passwort:\n${"> a\n".repeat(50_000)}`],
    ["viele Bezeichnungen allein auf ihrer Zeile", "Passwort\n".repeat(20_000)],
    ["viele allein stehende Bezeichnungen mit Satz", "Token\nDie Abrechnung läuft.\n".repeat(8_000)],
    ["viele offene Tags", "Passwort: <pre>\n".repeat(14_000)],
    ["viele Tags über Zeilen", "Passwort: <code>a\n".repeat(12_000)],
    ["viele geschlossene Tags mit Maske", "Passwort: <pre>[maskiert]</pre>\n".repeat(6_000)],
    ["viele offene Klammern am Zeilenende", "Passwort: (\n".repeat(16_000)],
    ["viele Klammern über Zeilen ohne Wert", "Passwort: (siehe\nTresor)\n".repeat(8_000)],
    ["Tag ohne Ende", `Passwort: <pre>${" a".repeat(100_000)}`],
    ["viele Werte mit eingerückten Zeilen", "Passwort: a1\n  b\n".repeat(12_000)],
    ["viele weitere Werte in Anführungszeichen", `Passwort: "a" ${'und "b" '.repeat(20_000)}`],
    ["viele Cookies", "Cookie: a=b; ".repeat(14_000)],
    // Runde 9: Kommentar hinter dem YAML-Einstieg, Verschachtelung
    ["viele YAML-Blöcke mit Kommentar", "password: | # k\n".repeat(14_000)],
    ["YAML-Kommentar ohne Zeilenende", `password: | #${" a".repeat(100_000)}`],
    ["viele verschachtelte Tags", "Passwort: <div><div>a</div>\n".repeat(9_000)],
    ["tiefe Verschachtelung", `Passwort: ${"<div>".repeat(30_000)}a${"</div>".repeat(30_000)}`],
    ["tiefe Verschachtelung ohne Ende", `Passwort: ${"(\n".repeat(60_000)}`],
    ["viele innere Klammern ohne äußeres Ende", "Passwort: (a\n(b)\n".repeat(10_000)],
    ["viele Klammern über Zeilen mit innerem Paar", "Passwort: (a\n(b)\nc)\n".repeat(8_000)],
    // Runde 12: beide Lesarten, bis zum passenden Ende und bis zum ersten Schlusszeichen
    ["viele verschachtelte Werte mit beschreibendem Schluss", "PIN: (a\n(b)\noptional)\n".repeat(8_000)],
    ["beschreibender Schluss hinter vielen inneren Klammern", `Passwort: (a\n${"(b)\n".repeat(40_000)}optional)`],
  ])("%s bleibt schnell", (_name, text) => {
    expect(fastestRun(() => maskSecrets(text))).toBeLessThan(RUNTIME_LIMIT_MS);
  });

  test("die Messung gibt einen dauerhaft langsamen Lauf nicht auf eine Ausnahme hin frei", () => {
    let runs = 0;
    const slow = () => {
      runs++;
      const until = performance.now() + 3;
      while (performance.now() < until);
    };
    expect(fastestRun(slow, 2)).toBeGreaterThanOrEqual(2);
    expect(runs).toBe(RUNTIME_ATTEMPTS);
  });

  test("ein einzelner Ausreißer unter Last zählt nicht, die Messung hört beim ersten guten Lauf auf", () => {
    let runs = 0;
    const once = () => {
      runs++;
      if (runs > 1) return;
      const until = performance.now() + 5;
      while (performance.now() < until);
    };
    expect(fastestRun(once, 4)).toBeLessThan(4);
    expect(runs).toBe(2);
  });
});
