/**
 * Issue #524: Die Erkennung muss für jede Kombination aus Bezeichnung, Schreibweise und
 * Wertform gelten, nicht nur für die, die jemand als Beispiel notiert hat. Die Prüfung fand
 * in fünf Runden jeweils eine neue Kombination. Diese Tabelle deckt das ganze Kreuzprodukt ab.
 * Alle Werte sind erfunden und zur Laufzeit zusammengesetzt.
 */
import { describe, expect, test } from "bun:test";
import { containsSecret, maskSecrets, SECRET_MASK } from "../src/lib/memory/secrets";

const MARKS = ["", "*", "**", "***", "_", "__", "___", "~~", "**_", "_**", "<b>", "<strong>", "<em>", "<code>", "<i>"];
function closing(mark: string): string {
  if (mark.startsWith("<")) return mark.replace("<", "</");
  return [...mark].reverse().join("");
}

/** Mit Hervorhebung in jeder Lage und jedem Trenner; {L} ist die Bezeichnung, {V} der Wert, {M} und {C} öffnen und schließen */
const LINE_FORMS = [
  "{M}{L}:{C} {V}",
  "{M}{L}{C}: {V}",
  "{L}: {M}{V}{C}",
  "{M}{L}: {V}{C}",
  "{M}{L}:{C} {M}{V}{C}",
  "{M}{L}{C}={V}",
  "{M}{L}{C} = {V}",
  "{M}{L}{C} => {V}",
  "{M}{L}{C} -> {V}",
  "{M}{L}{C} → {V}",
  "{M}{L}{C} := {V}",
  "{M}{L}{C} - {V}",
  "{M}{L}{C} – {V}",
  "{M}{L}{C} — {V}",
  "{M}{L} -{C} {V}",
  "{L} - {M}{V}{C}",
  "{M}{L}{C}: `{V}`",
  '{M}{L}{C}: "{V}"',
  "{M}{L}{C}: „{V}“",
  '"{L}": "{V}"',
  "Seite imker.example: {M}{L}{C}: {V}",
  "- {M}{L}{C}: {V}",
  "> {M}{L}{C}: {V}",
];

const CELL_FORMS = [
  "| {M}{L}{C} | {V} |",
  "| {L} | {M}{V}{C} |",
  "| {M}{L}{C} | {M}{V}{C} |",
  "|{M}{L}{C}|{V}|",
  "| {M}{L}:{C} | {V} |",
  "{M}{L}{C} | {V}",
  "| Feld | Inhalt |\n|---|---|\n| {M}{L}{C} | {V} |",
  "| Nutzer | {M}{L}{C} |\n|---|---|\n| alex | {V} |",
  "| {M}{L}{C} | Nutzer |\n| --- | --- |\n| {V} | alex |",
  "Nutzer | {M}{L}{C}\n---|---\nalex | {V}",
  "| Nutzer | alex | {M}{L}{C} | {V} | Rolle | admin |",
  "steht als | {M}{L}{C} | {V} | schon da",
  "| Nutzer | {M}{L}{C} | |---|---| | alex | {V} |",
];

/** Weniger deutliche Trenner: Hier zählt nur ein Wert, der nicht wie ein Wort des Satzes aussieht */
const WEAK_FORMS = ["{M}{L}{C} ist {V}", "{M}{L} ist{C} {V}", "{M}{L}{C} lautet {V}", "{M}{L}{C} {V}", "Das {M}{L}{C} ist {V}.", "{M}{L} für imker.example{C}: {V}", "{M}{L}{C} für die Seite ist {V}"];

const PASSWORD_LABELS = ["Passwort", "passwort", "PASSWORT", "Kennwort", "Password", "Passphrase", "Passcode", "PW", "pwd", "Seitenpasswort", "Neues Passwort", "DB_PASSWORD", "DB_PASS"];
const KEY_LABELS = ["API-Key", "api_key", "apiKey", "Token", "access_token", "accessToken", "Secret", "client_secret", "appSecret", "Schlüssel", "Lizenzschlüssel", "Zugangstoken", "GROQ_KEY", "TELEGRAM_BOT_TOKEN"];
const PIN_LABELS = ["PIN", "Pin", "pin", "Geheimzahl"];

const WORD_VALUE = ["Sommer", "wiese77"].join("");
const PLAIN_VALUE = ["Wald", "meister"].join("");
const PHRASE_VALUE = "Sommer Wiese";
const KEY_VALUE = ["ab12", "cd34", "ef56"].join("");
const LONG_KEY = ["abcd", "1234", "EFGH", "5678", "ijkl"].join("");
const PIN_VALUE = ["47", "11"].join("");
const PIN_GROUPS = "47 11";
const PIN_THREE = "47 11 08";

function fill(form: string, label: string, value: string, mark: string): string {
  return form.replaceAll("{L}", label).replaceAll("{V}", value).replaceAll("{M}", mark).replaceAll("{C}", closing(mark));
}

/** Teile des Werts, die im maskierten Text nicht mehr stehen dürfen */
const partsOf = (value: string) => value.split(" ").filter(part => part.length >= 2);

/** Ohne Fund: die Fälle als Liste, damit ein roter Lauf alle Kombinationen nennt und nicht nur die erste */
function misses(texts: readonly { text: string; value: string }[]): string[] {
  const out: string[] = [];
  for (const { text, value } of texts) {
    const masked = maskSecrets(text);
    if (!containsSecret(text)) out.push(`nicht erkannt: ${text}`);
    else if (!masked.includes(SECRET_MASK)) out.push(`keine Maske: ${text}`);
    else if (partsOf(value).some(part => masked.includes(part))) out.push(`Rest sichtbar: ${text} -> ${masked}`);
    else if (maskSecrets(masked) !== masked) out.push(`nicht wiederholbar: ${text} -> ${masked} -> ${maskSecrets(masked)}`);
  }
  return out;
}

function matrix(labels: readonly string[], values: readonly string[], forms: readonly string[]) {
  return labels.flatMap(label =>
    forms.map(form => {
      const texts = values.flatMap(value => MARKS.map(mark => ({ text: fill(form, label, value, mark), value })));
      return [label, form, texts] as const;
    }),
  );
}

describe("Passwort-Bezeichnungen im Fließtext", () => {
  test.each(matrix(PASSWORD_LABELS, [WORD_VALUE, PLAIN_VALUE, PHRASE_VALUE], LINE_FORMS))("%s, Form %s", (_label, _form, texts) => {
    expect(misses(texts)).toEqual([]);
  });
});

describe("Passwort-Bezeichnungen in Tabellen", () => {
  test.each(matrix(PASSWORD_LABELS, [WORD_VALUE, PLAIN_VALUE, PHRASE_VALUE], CELL_FORMS))("%s, Form %s", (_label, _form, texts) => {
    expect(misses(texts)).toEqual([]);
  });
});

describe("Trenner ohne Satzzeichen", () => {
  test.each(matrix(PASSWORD_LABELS, [WORD_VALUE], WEAK_FORMS))("Passwort-Bezeichnung %s, Form %s", (_label, _form, texts) => {
    expect(misses(texts)).toEqual([]);
  });

  test.each(matrix(KEY_LABELS, [KEY_VALUE, LONG_KEY], WEAK_FORMS))("Schlüssel-Bezeichnung %s, Form %s", (_label, _form, texts) => {
    expect(misses(texts)).toEqual([]);
  });

  test.each(matrix(PIN_LABELS, [PIN_VALUE, PIN_GROUPS], WEAK_FORMS))("PIN-Bezeichnung %s, Form %s", (_label, _form, texts) => {
    expect(misses(texts)).toEqual([]);
  });

  test.each(matrix(PASSWORD_LABELS, [PLAIN_VALUE, PHRASE_VALUE], ["Das {M}{L}{C} ist {V}", "{M}{L}{C} ist {V}."]))("groß geschriebene Wörter hinter „ist“: %s, Form %s", (_label, _form, texts) => {
    expect(misses(texts)).toEqual([]);
  });
});

describe("Schlüssel-Bezeichnungen", () => {
  test.each(matrix(KEY_LABELS, [KEY_VALUE, LONG_KEY], [...LINE_FORMS, ...CELL_FORMS]))("%s, Form %s", (_label, _form, texts) => {
    expect(misses(texts)).toEqual([]);
  });

  test.each(matrix(KEY_LABELS, [PHRASE_VALUE], CELL_FORMS))("mehrere Wörter in einer Zelle: %s, Form %s", (_label, _form, texts) => {
    expect(misses(texts)).toEqual([]);
  });
});

describe("PIN, auch in Zifferngruppen", () => {
  test.each(matrix(PIN_LABELS, [PIN_VALUE, PIN_GROUPS, PIN_THREE], [...LINE_FORMS, ...CELL_FORMS]))("%s, Form %s", (_label, _form, texts) => {
    expect(misses(texts)).toEqual([]);
  });
});

describe("Authorization", () => {
  const values = ["Basic dXNlcjpwYXNz", "basic dXNlcjpwYXNz", "Token abc123def456", "Bearer ab12cd34ef56gh78ij90", "bearer ab12cd34"];
  const lineForms = ["{M}{L}:{C} {V}", "{M}{L}{C}: {V}", "{M}{L}: {V}{C}", "{L}: {M}{V}{C}", "{M}{L}{C} = {V}", "{M}{L}{C} - {V}", "{M}{L}{C} -> {V}", "Kopfzeile {M}{L}{C}: {V}"];
  const texts = (forms: readonly string[]) =>
    forms.flatMap(form =>
      values.flatMap(value =>
        ["Authorization", "authorization", "AUTHORIZATION", "Proxy-Authorization"].flatMap(label =>
          MARKS.map(mark => ({ text: fill(form, label, value, mark), value: value.split(" ")[1] })),
        ),
      ),
    );

  test("im Fließtext", () => {
    expect(misses(texts(lineForms))).toEqual([]);
  });

  test("in Tabellen", () => {
    expect(misses(texts(CELL_FORMS))).toEqual([]);
  });

  test("ohne Verfahren, wenn der Wert wie ein Token aussieht", () => {
    expect(maskSecrets("_Authorization: abcd1234efgh5678ijkl_")).toBe(`_Authorization: ${SECRET_MASK}`);
    expect(maskSecrets("Authorization: Erforderlich")).toBe("Authorization: Erforderlich");
    expect(maskSecrets("_Authorization_ ist Pflicht")).toBe("_Authorization_ ist Pflicht");
  });
});

/**
 * Hervorhebungen entfernt eine eigene Stufe vor allen Mustern, sie sind von der Wertform unabhängig.
 * Für die Kreuzprodukte unten reicht darum je eine Art.
 */
const SOME_MARKS = ["", "**", "_", "~~", "<b>"];
/** Große Kreuzprodukte: Auf einem ausgelasteten Rechner reichen die üblichen 5 Sekunden nicht */
const LARGE_MS = 120_000;

describe("jede Wertform hinter Authorization und Bearer", () => {
  const LABELS = ["Authorization", "authorization", "AUTHORIZATION", "Proxy-Authorization"];
  const TOKEN = ["abcdef", "1234567890", "abcd"].join("");
  const BASIC = ["dXNl", "cjpw", "YXNz"].join("");
  const WRAPPED = ['"{T}"', "'{T}'", "`{T}`", "```{T}```", "„{T}“", "“{T}”", "»{T}«", "«{T}»", "({T})", "[{T}]", "<{T}>", "{{T}}", "{T}", "{T},", "{T}."];
  const FORMS = ["{M}{L}:{C} {V}", "{M}{L}{C}: {V}", "{L}: {M}{V}{C}", "{M}{L}{C}={V}", "{M}{L}{C} = {V}", "{M}{L}{C} => {V}", "{M}{L}{C} - {V}", "Kopfzeile {M}{L}{C}: {V} gesendet", "{M}{L}{C}: {V}\nNutzer alex", "| {M}{L}{C} | {V} |", "| Nutzer | {M}{L}{C} |\n|---|---|\n| alex | {V} |"];
  const SCHEMES = ["Basic", "basic", "BASIC", "Bearer", "bearer", "Token", "token", "Digest", "Negotiate", '"Bearer"', "`Basic`", "**Bearer**"];

  test.each(LABELS)("%s: Verfahren und zitierter Wert", label => {
    const texts = FORMS.flatMap(form =>
      SCHEMES.flatMap(scheme =>
        WRAPPED.flatMap(wrap =>
          [TOKEN, BASIC].flatMap(token => SOME_MARKS.map(mark => ({ text: fill(form, label, `${scheme} ${wrap.replace("{T}", token)}`, mark), value: token }))),
        ),
      ),
    );
    expect(misses(texts)).toEqual([]);
  }, LARGE_MS);

  test.each(LABELS)("%s: ganzer Wert in Anführungszeichen", label => {
    const QUOTES = [['"', '"'], ["'", "'"], ["`", "`"], ["„", "“"]];
    const texts = FORMS.flatMap(form =>
      QUOTES.flatMap(([open, close]) =>
        SCHEMES.slice(0, 7).flatMap(scheme => SOME_MARKS.map(mark => ({ text: fill(form, label, `${open}${scheme} ${TOKEN}${close}`, mark), value: TOKEN }))),
      ),
    );
    expect(misses(texts)).toEqual([]);
  }, LARGE_MS);

  test.each(LABELS)("%s: zitiert ohne Verfahren", label => {
    const texts = FORMS.flatMap(form => WRAPPED.flatMap(wrap => SOME_MARKS.map(mark => ({ text: fill(form, label, wrap.replace("{T}", TOKEN), mark), value: TOKEN }))));
    expect(misses(texts)).toEqual([]);
  }, LARGE_MS);

  test("Bearer ohne Kopfzeile, in jeder Wertform", () => {
    const forms = ["{M}Bearer{C} {V}", "{M}bearer{C} {V}", "{M}BEARER{C} {V}", "{M}Bearer {V}{C}", "Bearer {M}{V}{C}", "Bearer: {V}", "Bearer={V}", "Der Zugang ist {M}Bearer{C} {V} für das Projekt", "| {M}Bearer{C} | {V} |"];
    const texts = forms.flatMap(form => WRAPPED.flatMap(wrap => SOME_MARKS.map(mark => ({ text: fill(form, "", wrap.replace("{T}", TOKEN), mark), value: TOKEN }))));
    expect(misses(texts)).toEqual([]);
  }, LARGE_MS);

  test("Verweise bleiben frei, in jeder Wertform", () => {
    const REFERENCES = ["$TOKEN", "${TOKEN}", "<token>", "<dein token>", SECRET_MASK];
    const forms = ["{M}{L}:{C} Bearer {V}", '{L}: Bearer "{V}"', "{L}: Bearer `{V}`", '{L}: "Bearer {V}"', "{L}: Basic '{V}'", "| {L} | Bearer {V} |", '| {L} | "Bearer {V}" |'];
    const wrong: string[] = [];
    for (const form of forms) {
      for (const value of REFERENCES) {
        for (const mark of SOME_MARKS) {
          const text = fill(form, "Authorization", value, mark);
          if (containsSecret(text)) wrong.push(`${text} -> ${maskSecrets(text)}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("ein Wert wird nie abgeschnitten, gleich wie lang er ist", () => {
  const POOL = ["Birke", "Wolke", "Honig", "Kiesel", "Mond", "Fichte", "Regen", "Tanne", "Eiche", "Linde", "Ahorn", "Buche"];
  const phraseOf = (count: number) => Array.from({ length: count }, (_, index) => `${POOL[index % POOL.length]}${index >= POOL.length ? index : ""}`).join(" ");
  const COUNTS = [2, 3, 5, 6, 7, 8, 12, 13, 25, 60, 300];
  const PHRASE_FORMS = ["{M}{L}:{C} {V}", "{M}{L}{C}: {V}", "{L}: {M}{V}{C}", "{M}{L}{C}={V}", "{M}{L}{C} = {V}", "{M}{L}{C} => {V}", "{M}{L}{C} - {V}", "{M}{L}{C} – {V}", "{M}{L}{C}: {V}.", "{M}{L}{C}: {V}, Nutzer alex", "{M}{L}{C}: {V}\nNutzer alex", "- {M}{L}{C}: {V}", "| {M}{L}{C} | {V} |", "{M}{L}{C} | {V}", "| Nutzer | {M}{L}{C} |\n|---|---|\n| alex | {V} |", "Das {M}{L}{C} ist {V}", "{M}{L}{C} lautet {V}"];

  test.each(PASSWORD_LABELS)("Passphrase hinter %s", label => {
    const texts = PHRASE_FORMS.flatMap(form => COUNTS.flatMap(count => SOME_MARKS.map(mark => ({ text: fill(form, label, phraseOf(count), mark), value: phraseOf(count) }))));
    expect(misses(texts)).toEqual([]);
  }, LARGE_MS);

  const PIN_FORMS = [...PHRASE_FORMS.filter(form => !form.includes("lautet")), "{M}{L}{C} {V}", "{M}{L}{C} {V} für das Tor"];
  const groupsOf = (count: number) => Array.from({ length: count }, (_, index) => `${10 + (index % 90)}`).join(" ");

  test.each(PIN_LABELS)("Zifferngruppen hinter %s", label => {
    const texts = PIN_FORMS.flatMap(form =>
      COUNTS.flatMap(count =>
        SOME_MARKS.map(mark => {
          const value = groupsOf(count);
          return { text: fill(form, label, value, mark), value };
        }),
      ),
    );
    const out: string[] = [];
    for (const { text, value } of texts) {
      const masked = maskSecrets(text);
      if (!containsSecret(text)) out.push(`nicht erkannt: ${text}`);
      // Mehr als eine einzelne Gruppe darf nicht übrig bleiben, und auch die nicht
      for (const group of value.split(" ")) if (new RegExp(`(^|[^\\d])${group}([^\\d]|$)`).test(masked.replaceAll(/\[[^\]]*\]/g, ""))) out.push(`Rest ${group}: ${text} -> ${masked}`);
    }
    expect(out).toEqual([]);
  }, LARGE_MS);

  test("einzelne Ziffern als Gruppen", () => {
    expect(maskSecrets("PIN: 1 2 3 4 5 6 7 8")).toBe(`PIN: ${SECRET_MASK}`);
    expect(maskSecrets("PIN: 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0")).toBe(`PIN: ${SECRET_MASK}`);
  });

  test("die Gegenproben aus der Prüfung", () => {
    expect(maskSecrets("Passwort: Birke Wolke Honig Kiesel Mond Fichte Regen")).toBe(`Passwort: ${SECRET_MASK}`);
    expect(maskSecrets("PIN: 1 2 3 4 5 6 7 8")).toBe(`PIN: ${SECRET_MASK}`);
  });

  test("eine Liste bis zum Zeilenende gehört zum Wert, ein weiteres Feld nicht", () => {
    expect(maskSecrets("Passwort: Birke, Wolke, Honig, Kiesel")).toBe(`Passwort: ${SECRET_MASK}`);
    expect(maskSecrets("Passwort: Birke; Wolke")).toBe(`Passwort: ${SECRET_MASK}`);
    expect(maskSecrets("Passwort: Wolke Birke, Honig")).toBe(`Passwort: ${SECRET_MASK}`);
    expect(maskSecrets(`Passwort: Sommer, wiese77`)).toBe(`Passwort: ${SECRET_MASK}`);
    expect(maskSecrets("Login: alex / Birke, Wolke")).toBe(`Login: alex / ${SECRET_MASK}`);
    expect(maskSecrets("PIN: 4711, 0815")).toBe(`PIN: ${SECRET_MASK}`);
    expect(maskSecrets("PIN: 1 2 3 4, 5 6 7 8")).toBe(`PIN: ${SECRET_MASK}`);
    expect(maskSecrets("Passwort: Birke,\nNutzer alex")).toBe(`Passwort: ${SECRET_MASK},\nNutzer alex`);
    expect(maskSecrets(`Passwort: ${WORD_VALUE}, Nutzer alex`)).toBe(`Passwort: ${SECRET_MASK}, Nutzer alex`);
    expect(maskSecrets(`Passwort: ${WORD_VALUE}, Token: ${KEY_VALUE}`)).toBe(`Passwort: ${SECRET_MASK}, Token: ${SECRET_MASK}`);
    expect(maskSecrets("PIN: 12 34, für das Tor")).toBe(`PIN: ${SECRET_MASK}, für das Tor`);
  });

  test("was hinter dem Wert folgt, bleibt lesbar", () => {
    expect(maskSecrets(`Passwort: ${phraseOf(8)} für die Seite`)).toBe(`Passwort: ${SECRET_MASK} für die Seite`);
    expect(maskSecrets(`Passwort: ${phraseOf(8)}, Nutzer alex`)).toBe(`Passwort: ${SECRET_MASK}, Nutzer alex`);
    expect(maskSecrets(`Passwort: ${phraseOf(8)} (alt)`)).toBe(`Passwort: ${SECRET_MASK} (alt)`);
    expect(maskSecrets(`Passwort: ${phraseOf(8)} Nutzer:alex`)).toBe(`Passwort: ${SECRET_MASK} Nutzer:alex`);
    expect(maskSecrets(`Passwort: ${phraseOf(8)} und Token: ${KEY_VALUE}`)).toBe(`Passwort: ${SECRET_MASK} und Token: ${SECRET_MASK}`);
    expect(maskSecrets("PIN: 1 2 3 4 5 6 7 8 für das Tor")).toBe(`PIN: ${SECRET_MASK} für das Tor`);
  });

  test.each(KEY_LABELS)("mehrere Ketten hinter %s", label => {
    const chains = [KEY_VALUE, LONG_KEY, ["cd34", "ef56", "ab12"].join(""), ["zz99", "yy88", "xx77"].join("")].join(" ");
    const texts = ["{M}{L}:{C} {V}", "{M}{L}{C} = {V}", "{M}{L}{C} {V}", "{M}{L}{C}: {V}.", "{M}{L}{C}: {V} gilt noch"].flatMap(form => SOME_MARKS.map(mark => ({ text: fill(form, label, chains, mark), value: chains })));
    expect(misses(texts)).toEqual([]);
  });

  test("Paar aus Name und Wert: dieselben Wertformen wie überall", () => {
    const VALUES = [WORD_VALUE, `"${WORD_VALUE}"`, "`Sommer Wiese 77`", `"${phraseOf(8)}"`, phraseOf(8).replace("Birke", WORD_VALUE)];
    const out = ["Login: alex / {V}", "Zugang alex / {V}", "WLAN: Imkerei / {V}", "Konto: Alex / {V}"].flatMap(form =>
      VALUES.map(value => ({ text: form.replace("{V}", value), value: value.replace(/["`]/g, "") })),
    );
    expect(misses(out)).toEqual([]);
  });
});

describe("eine Bezeichnung in einem Pfad nennt keinen Wert", () => {
  const LABELS = ["Passwort", "passwort", "Passwörter", "Kennwort", "Password", "PW", "pw", "Token", "API-Key", "API Key", "Secret", "Schlüssel", "PIN"];
  const NAMES = ["{L} Backup2026", "{L} Backup 2026", "Meine {L} 2026", "Alte {L} Backup2026abcd", "{L} - Backup2026", "{L} 1234"];
  const ROOTS = ["/Users/alex/", "/home/alex/Alte Dateien/", "~/", "./", "../", "C:\\Users\\alex\\", "D:\\Daten\\Alte Dateien\\", "\\\\server\\freigabe\\", "/Volumes/USB Stick/", "file:///Users/alex/"];
  const AROUND = ["{P}", "Die Datei liegt unter {P}", "Ordner: {P}", "{P} ist voll", '"{P}"', "'{P}'", "`{P}`", "({P})", "| Pfad | {P} |", "Siehe {P}, Stand 2026"];
  const withEnd = (root: string, name: string) => {
    const separator = root.includes("\\") ? "\\" : "/";
    return [`${root}${name}${separator}notizen.txt`, `${root}${name}${separator}`, `${root}${name}${separator}archiv${separator}alt.tar.gz`];
  };

  test.each(LABELS)("%s als Ordnername", label => {
    const wrong: string[] = [];
    for (const name of NAMES) {
      for (const root of ROOTS) {
        for (const path of withEnd(root, name.replaceAll("{L}", label))) {
          for (const around of AROUND) {
            for (const mark of ["", "**", "_", "<b>"]) {
              const text = `${mark}${around.replace("{P}", path)}${closing(mark)}`;
              if (containsSecret(text)) wrong.push(`${text} -> ${maskSecrets(text)}`);
            }
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  }, LARGE_MS);

  test.each(LABELS)("%s im letzten Teil eines Pfads mit Wurzel", label => {
    const wrong: string[] = [];
    for (const root of ROOTS) {
      for (const tail of [" Backup2026", " Backup 2026", " - Backup2026"]) {
        const text = `${root}${label}${tail}`;
        if (containsSecret(text)) wrong.push(`${text} -> ${maskSecrets(text)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test.each(LABELS)("%s in einem Pfad ohne Wurzel, der als Datei oder Ordner endet", label => {
    const wrong: string[] = [];
    for (const text of [`docs/${label} Backup2026/notizen.txt`, `Backup/${label} Backup2026/alt/`, `Dokumente\\${label} Backup2026\\notizen.txt`, `${label} Backup2026/notizen.txt`, `Backup/${label} 2026 alt/notizen.txt`]) {
      if (containsSecret(text)) wrong.push(`${text} -> ${maskSecrets(text)}`);
    }
    expect(wrong).toEqual([]);
  });

  test.each(PASSWORD_LABELS.filter(label => !label.includes("_")))("ein deutlicher Trenner oder ein Pfad davor ändert nichts am Wert: %s", label => {
    const texts = [
      `/opt/app/${label}: {V}`,
      `/opt/app/${label} = {V}`,
      `C:\\app\\${label}: {V}`,
      `Nutzer/${label}: {V}`,
      `Nutzer/${label}: alex/{V}`,
      `/etc/app ${label}: {V}`,
      `/etc/app/notizen.txt ${label} = {V}`,
      `~/notizen.txt, ${label}: {V}`,
      `https://imker.example/login ${label}: {V}`,
      `/Users/alex/${label} "{V}"`,
      `/Users/alex/Alte Dateien/notizen.txt ${label}: {V}`,
    ].map(text => ({ text: text.replace("{V}", WORD_VALUE), value: WORD_VALUE }));
    expect(misses(texts)).toEqual([]);
  });
});

describe("Werte, die sich selbst verraten", () => {
  const body = "Ab3dE6gH9k".repeat(4);
  const values = [`ghp_${body}`, `sk-ant-${body}`, `sk_${body}`, `gsk_${body}`, `AIza${body}`, `123456789:${body}`, `Bearer ab12cd34ef56gh78ij90`, `bearer ab12cd34ef56gh78ij90`, body];
  const forms = ["{M}{V}{C}", "Der Zugang ist {M}{V}{C} für das Projekt", "({M}{V}{C})", "Zugang: {M}{V}{C}.", "| {M}{V}{C} |", "- {M}{V}{C}"];

  test("in jeder Hervorhebung und Lage", () => {
    const texts = forms.flatMap(form => values.flatMap(value => MARKS.map(mark => ({ text: fill(form, "", value, mark), value: value.split(" ").pop()! }))));
    expect(misses(texts)).toEqual([]);
  });
});

describe("ein begrenzter Wert gilt bis zum schließenden Zeichen, auch über Zeilen", () => {
  const PAIRS = [['"', '"'], ["'", "'"], ["`", "`"], ["``", "``"], ["```", "```"], ["~~~", "~~~"], ['"""', '"""'], ["'''", "'''"], ["„", "“"], ["»", "«"]];
  const LABELS = ["Passwort", "Kennwort", "PW", "DB_PASSWORD"];
  const BODIES = [`\n${WORD_VALUE}\n`, `Birke\n${WORD_VALUE}`, `${WORD_VALUE}\nBirke`, `\n\nBirke\n\n${WORD_VALUE}\n\n`];

  test("jede Bezeichnung, jedes Paar, jeder Inhalt: erkannt, kein Rest, wiederholbar", () => {
    const wrong: string[] = [];
    for (const label of LABELS) {
      for (const [open, close] of PAIRS) {
        for (const body of BODIES) {
          for (const form of [`${label}: {V}`, `**${label}:** {V}`, `${label} = {V}`, `${label}:\n{V}`]) {
            const text = form.replace("{V}", `${open}${body}${close}`);
            const masked = maskSecrets(text);
            if (masked !== form.replace("{V}", `${open}${SECRET_MASK}${close}`)) wrong.push(`${text} -> ${masked}`);
            if (maskSecrets(masked) !== masked) wrong.push(`nicht wiederholbar: ${masked}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test("ein Zitat ohne Bezeichnung bleibt frei, gleich in welchem Paar", () => {
    const wrong: string[] = [];
    for (const [open, close] of PAIRS) {
      for (const body of ["Erster Satz.\nZweiter Satz.", "\nbun run check\nbun test\n", `Stand ${"12"}\nam Montag`]) {
        const text = `${open}${body}${close}`;
        if (containsSecret(text)) wrong.push(text);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("ohne schließendes Zeichen bleibt vom Absatz nichts stehen, der nächste Absatz schon", () => {
    expect(maskSecrets(`Passwort: "Birke\n${WORD_VALUE}\n\nNächster Absatz`)).toBe(`Passwort: "${SECRET_MASK}\n\nNächster Absatz`);
    expect(maskSecrets(`Passwort: \`\`\`\n${WORD_VALUE}\n\nNoch im Block`)).toBe(`Passwort: \`\`\`${SECRET_MASK}`);
  });

  test("eine Bezeichnung in einem Absatz ohne Wert wird weiter gelesen", () => {
    expect(maskSecrets(`Hinweise zum Passwort\n"Ein Absatz.\nPasswort: ${WORD_VALUE}\nEnde."`)).toBe(`Hinweise zum Passwort\n"Ein Absatz.\nPasswort: ${SECRET_MASK}\nEnde."`);
    const long = `Hinweise zum Passwort\n\`\`\`\n${"Eine lange Zeile ohne Wert.\n".repeat(20)}Passwort: ${WORD_VALUE}\n\`\`\``;
    expect(maskSecrets(long)).not.toContain(WORD_VALUE);
  });
});

describe("eine Kopfzeile gilt bis zum Zeilenende", () => {
  const LABELS = ["Authorization", "authorization", "AUTHORIZATION", "Proxy-Authorization"];
  const SCHEMES = ["Digest", "digest", "AWS4-HMAC-SHA256", "GOOG4-HMAC-SHA256", "OAuth", "Basic", "Bearer"];
  const SIGN = "fedcba9876543210".repeat(2);
  const LISTS = [`username="mia", response="${SIGN}"`, `a="b", response="${SIGN}"`, `Credential=mia/s3, SignedHeaders=host, Signature=${SIGN}`, `a=b,c=d,signature=${SIGN}`];

  test("jedes Verfahren, jede Parameterliste: das Verfahren bleibt, von den Parametern nichts", () => {
    const wrong: string[] = [];
    for (const label of LABELS) {
      for (const scheme of SCHEMES) {
        for (const list of LISTS) {
          const masked = maskSecrets(`${label}: ${scheme} ${list}`);
          if (masked !== `${label}: ${scheme} ${SECRET_MASK}`) wrong.push(masked);
          if (maskSecrets(masked) !== masked) wrong.push(`nicht wiederholbar: ${masked}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test("die Zeile darunter und die nächste Spalte bleiben", () => {
    expect(maskSecrets(`Authorization: Digest a="b", c="${SIGN}"\nNächste Zeile`)).toBe(`Authorization: Digest ${SECRET_MASK}\nNächste Zeile`);
    expect(maskSecrets(`| Authorization: Digest a="b", c="${SIGN}" | Rolle |`)).toBe(`| Authorization: Digest ${SECRET_MASK} | Rolle |`);
  });
});

describe("was die Bezeichnung als Wert nicht gelten lässt, in jeder Schreibweise", () => {
  const REFERENCES = [SECRET_MASK, "<wert>", "<dein passwort>", "$DB_PASS", "${DB_PASS}", "process.env.DB_PASS", ".env", "~/.env", "***", "(siehe Tresor)", "siehe .env", "steht in der .env", "/etc/app/pw", "./pw.txt"];
  // In Anführungszeichen sind sie Werte: Passwort: "gesetzt"
  const STATES = ["gesetzt", "vergessen", "abgelaufen", "noch nicht gesetzt"];
  const isQuoted = (form: string) => /["`„]\{V\}/.test(form);
  const FORMS = LINE_FORMS.filter(form => !form.includes('"{L}"')).concat(CELL_FORMS.filter(form => !form.includes("---") && !form.includes("alex")));

  test.each([...PASSWORD_LABELS, ...KEY_LABELS])("%s", label => {
    const wrong: string[] = [];
    for (const form of FORMS) {
      for (const value of isQuoted(form) ? REFERENCES : [...REFERENCES, ...STATES]) {
        for (const mark of MARKS) {
          const text = fill(form, label, value, mark);
          if (containsSecret(text)) wrong.push(`${text} -> ${maskSecrets(text)}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("kein Fehlalarm in jeder Hervorhebung", () => {
  const hash = "0123456789abcdef".repeat(3).slice(0, 40);
  const mixedHash = ["aBcDeF0123456789", "aBcDeF0123456789", "aBcDeF01"].join("");
  const chain = "Ab3dE6gH9k".repeat(4);
  const HARMLESS = [
    "1234567890",
    "Bestellnummer 1234567890",
    "Budget 1500000 Euro, 42 Prozent",
    "+49 170 1234567",
    hash,
    mixedHash,
    `Commit ${hash} ist der letzte Stand`,
    `Commit ${mixedHash}`,
    `git checkout ${hash.toUpperCase()}`,
    `sha256:${hash}`,
    "3f2b8c1e-9d4a-4c7b-8e21-5a6f7d8e9c01",
    "/Users/alex/.ssh/id_rsa",
    "~/.config/tybo/token.json",
    `/var/lib/app/${chain}/daten.bin`,
    `C:\\Users\\alex\\${chain}\\config.json`,
    `docs/${chain}.md`,
    `https://imker.example/bilder/${chain}/honig.png`,
    "https://imker.example:8443/start",
    "postgres://localhost:5432/app",
    "Port 3100, Version 2.16.0, Datum 2026-10-31",
    "12:30 Uhr Termin",
    "Zugang imker.example:8443",
    "Zugang server:3100",
    "Login https://imker.example/start",
    "Passwort vergessen",
    "Das Passwort ist abgelaufen",
    "Das Passwort ist Pflicht",
    "Das Passwort steht in der .env",
    "Passwort-Manager: Bitwarden",
    "Tokens: 1500",
    "max_tokens: 4096",
    "maxTokens: 4096",
    "Token-Limit 200000",
    "primary_key: user_id_2",
    "sort_key = created_at_2024",
    "PRIMARY_KEY: 12345",
    "PIN: 3",
    "PIN 12 Stellen",
    "| PIN | Berlin Mitte |",
    "| Token | 1500 |",
    "| Token | 15 20 |",
    "| Name | Token |\n|---|---|\n| alex | 1500 |",
    "cat app.log | grep Passwort | sort",
    "cat app.log | grep Passwort | sort -r | tail -5",
    "grep -i passwort app.log | tail -5",
    "ps aux | grep token | wc -l",
    "| Passwort | Beschreibung |\n|---|---|",
    "| Passwort | Letzte Änderung |\n|---|---|",
  ];

  test.each(HARMLESS)("%s", text => {
    const wrong: string[] = [];
    for (const mark of MARKS) {
      for (const decorated of [`${mark}${text}${closing(mark)}`, `Notiz: ${mark}${text}${closing(mark)} bleibt`]) {
        if (containsSecret(decorated)) wrong.push(`${decorated} -> ${maskSecrets(decorated)}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
