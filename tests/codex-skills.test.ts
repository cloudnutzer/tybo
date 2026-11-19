/** M14-13: echte Dateisystemfälle, ausschließlich unter einem eigenen Temp-Ordner. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { inspectCodexSkillLinks, syncCodexSkillLinks } from "../src/lib/engines/codex-skills";

let base: string, root: string, home: string, dest: string, ledgerPath: string;
let log: ReturnType<typeof spyOn>;
const head = (name = "tagesgruss") => `---\nname: ${name}\ndescription: Begrüßt mit einem Satz zum Wochentag.\nallowed-tools: Read, Bash(date *)\nuser-invocable: true\nargument-hint: "[name]"\n---\n\n# Tagesgruß\n`;
function file(path: string, text: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function skill(name = "tagesgruss", where = home, text = head(name)) {
  const path = join(where, ".claude", "skills", name);
  file(join(path, "SKILL.md"), text);
  return path;
}
const sync = (enabled = true) => syncCodexSkillLinks({ root, home, enabled });
const ledger = () => JSON.parse(readFileSync(ledgerPath, "utf8"));
function foreignLink(name: string, target: string) {
  mkdirSync(dest, { recursive: true });
  symlinkSync(target, join(dest, name), "dir");
}
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "tybo-skills-"));
  root = join(base, "projekt"); home = join(base, "heim");
  mkdirSync(root); mkdirSync(home);
  dest = join(root, ".agents", "skills");
  ledgerPath = join(root, "data", "codex-skill-links.json");
  log = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { log.mockRestore(); rmSync(base, { recursive: true, force: true }); });

test("Anlegen mit absolutem Ziel und Vermerk; zweiter Lauf ändert keine Zeiten und lässt keine Temp-Datei", () => {
  const source = skill();
  expect(sync()).toEqual({ linked: ["tagesgruss"], foreign: [], skipped: [] });
  const path = join(dest, "tagesgruss");
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  expect(readlinkSync(path)).toBe(source);
  expect(ledger()).toEqual({ version: 1, links: { tagesgruss: { target: source, createdAt: expect.any(String) } } });
  expect(new Date(ledger().links.tagesgruss.createdAt).toISOString()).toBe(ledger().links.tagesgruss.createdAt);
  const past = new Date("2001-01-01T00:00:00.000Z");
  for (const dir of [dest, dirname(dest), dirname(ledgerPath), ledgerPath]) utimesSync(dir, past, past);
  const paths = [dest, dirname(dest), dirname(ledgerPath), ledgerPath, path];
  const times = paths.map(p => lstatSync(p).mtimeMs);
  const before = readFileSync(ledgerPath, "utf8");
  expect(sync().linked).toEqual(["tagesgruss"]);
  expect(paths.map(p => lstatSync(p).mtimeMs)).toEqual(times);
  expect(readFileSync(ledgerPath, "utf8")).toBe(before);
  expect(readdirSync(dest)).toEqual(["tagesgruss"]);
  expect(readdirSync(dirname(ledgerPath))).toEqual(["codex-skill-links.json"]);
  expect(readFileSync(join(source, "SKILL.md"), "utf8")).toBe(head());
});

test("Projekt geht vor; Quellenwechsel ersetzt eigenen Link atomar und zurück", () => {
  const user = skill(); sync();
  const project = skill("tagesgruss", root);
  expect(sync().linked).toEqual(["tagesgruss"]);
  expect(readlinkSync(join(dest, "tagesgruss"))).toBe(project);
  expect(ledger().links.tagesgruss.target).toBe(project);
  expect(readdirSync(dest)).toEqual(["tagesgruss"]);
  rmSync(project, { recursive: true }); sync();
  expect(readlinkSync(join(dest, "tagesgruss"))).toBe(user);
});

test("Projektordner ohne SKILL.md ist keine Quelle und verdrängt keinen gültigen Home-Skill", () => {
  const source = skill();
  mkdirSync(join(root, ".claude", "skills", "tagesgruss"), { recursive: true });
  expect(sync()).toEqual({ linked: ["tagesgruss"], foreign: [], skipped: [{ name: "tagesgruss", reason: "head" }] });
  expect(readlinkSync(join(dest, "tagesgruss"))).toBe(source);
});

test("Namen ohne Rücksicht auf Großschreibung zusammenführen, auch nach einem Quellenwechsel", () => {
  skill("tagesgruss"); sync();
  const project = skill("Tagesgruss", root);
  sync();
  expect(readdirSync(dest)).toEqual(["tagesgruss"]);
  expect(readlinkSync(join(dest, "tagesgruss"))).toBe(project);
  const before = [statSync(dest).mtimeMs, statSync(ledgerPath).mtimeMs];
  sync();
  expect([statSync(dest).mtimeMs, statSync(ledgerPath).mtimeMs]).toEqual(before);
});

test("Quelle darf ein Link sein; Ziele bleiben ohne realpath genau wie resolve", () => {
  const actual = join(base, "extern");
  file(join(actual, "SKILL.md"), head());
  const aliasHome = join(base, "heim-alias");
  symlinkSync(home, aliasHome, "dir");
  const source = join(home, ".claude", "skills", "tagesgruss");
  mkdirSync(dirname(source), { recursive: true }); symlinkSync(actual, source, "dir");
  const input = { root: relative(process.cwd(), root), home: relative(process.cwd(), aliasHome), enabled: true };
  syncCodexSkillLinks(input);
  const expected = resolve(aliasHome, ".claude", "skills", "tagesgruss");
  expect(readlinkSync(join(dest, "tagesgruss"))).toBe(expected);
  expect(ledger().links.tagesgruss.target).toBe(expected);
  expect(syncCodexSkillLinks(input).linked).toEqual(["tagesgruss"]);
});

test("Nur unmittelbare Quellordner; fehlender oder ungültiger Kopf und ungültige Namen haben Gründe", () => {
  skill("ohne-kopf", home, "# Ohne Kopf\ndescription: gilt nicht\n");
  skill("leer", home, "---\ndescription: '  '\n---\n");
  skill("kaputt", home, "---\ndescription: [\n---\n");
  skill("synced/tagesgruss");
  for (const name of [".versteckt", "mit leerzeichen", "zeilenende\n", "x".repeat(65)]) skill(name);
  file(join(home, ".claude", "skills", "datei"), "kein Ordner");
  const r = sync();
  expect(r.linked).toEqual([]);
  for (const name of ["ohne-kopf", "leer", "kaputt", "synced"]) expect(r.skipped).toContainEqual({ name, reason: "head" });
  for (const name of [".versteckt", "mit leerzeichen", "zeilenende\n", "x".repeat(65)]) expect(r.skipped).toContainEqual({ name, reason: "name" });
  expect(r.skipped).toHaveLength(8);
  expect(existsSync(dest)).toBe(false);
});

test("Kopf: BOM, CRLF, fehlender Name, lange, gefaltete und wörtliche Beschreibung", () => {
  skill("bom", home, "\uFEFF" + head("bom").replaceAll("\n", "\r\n"));
  skill("namenlos", home, "---\ndescription: Ohne Namen.\n---\n");
  skill("lang", home, `---\ndescription: ${"Ein Gruß. ".repeat(160)}\n---\n`);
  for (const [name, marker] of [["gefaltet", ">"], ["woertlich", "|"]]) {
    skill(name, home, `---\ndescription: ${marker}\n  Ein Gruß.\n  Mehrzeilig.\n---\n`);
  }
  expect(sync().linked).toEqual(["bom", "gefaltet", "lang", "namenlos", "woertlich"]);
});

test("Kopf bleibt auf 8 KiB begrenzt; Beschreibung im Inhalt zählt nie", () => {
  skill("zu-lang", home, "---\ndescription: " + "x".repeat(8192) + "\n---\n");
  skill("nur-inhalt", home, "---\nname: nur-inhalt\n---\ndescription: zu spät\n");
  skill("grosser-inhalt", home, head("grosser-inhalt") + "x".repeat(200_000));
  const r = sync();
  expect(r.linked).toEqual(["grosser-inhalt"]);
  expect(r.skipped).toEqual([{ name: "nur-inhalt", reason: "head" }, { name: "zu-lang", reason: "head" }]);
});

test("Fremder Link auf dieselbe Quelle bleibt bei Quellenverlust und Abschalten unvermerkt", () => {
  const source = skill(); foreignLink("tagesgruss", source);
  foreignLink("unbeteiligt", join(base, "fehlt"));
  expect(sync().foreign).toEqual(["tagesgruss"]);
  sync();
  expect(log.mock.calls.filter(c => String(c[0]).includes("im Projekt selbst vorhanden"))).toHaveLength(1);
  expect(existsSync(ledgerPath)).toBe(false);
  rmSync(source, { recursive: true });
  expect(sync().foreign).toEqual([]);
  sync(false);
  expect(readlinkSync(join(dest, "tagesgruss"))).toBe(source);
  expect(readdirSync(dest).sort()).toEqual(["tagesgruss", "unbeteiligt"]);
});

test("Echter Ordner und fremder Link mit anderer Großschreibung bleiben vorrangig", () => {
  skill(); skill("abendgruss");
  file(join(dest, "tagesgruss", "eigen.txt"), "unverändert");
  foreignLink("Abendgruss", join(base, "eigen"));
  expect(sync().foreign.sort()).toEqual(["Abendgruss", "tagesgruss"]);
  sync(false);
  expect(readFileSync(join(dest, "tagesgruss", "eigen.txt"), "utf8")).toBe("unverändert");
  expect(readlinkSync(join(dest, "Abendgruss"))).toBe(join(base, "eigen"));
});

test("Vom Nutzer geändertes Ziel bleibt; ausschließlich der Vermerk verschwindet", () => {
  skill(); sync();
  const path = join(dest, "tagesgruss");
  unlinkSync(path); symlinkSync(join(base, "anderes-ziel"), path, "dir");
  expect(sync().foreign).toEqual(["tagesgruss"]);
  expect(ledger().links).toEqual({});
  sync(false);
  expect(readlinkSync(path)).toBe(join(base, "anderes-ziel"));
});

test("Anders geschriebener Nutzer-Link übernimmt keinen Vermerk des alten Namens", () => {
  const source = skill(); sync();
  renameSync(join(dest, "tagesgruss"), join(dest, "zwischenname"));
  renameSync(join(dest, "zwischenname"), join(dest, "Tagesgruss"));
  expect(sync().foreign).toEqual(["Tagesgruss"]);
  expect(ledger().links).toEqual({});
  sync(false);
  expect(readlinkSync(join(dest, "Tagesgruss"))).toBe(source);
});

test("Verschwundene Quelle: hängender eigener Link weg, fremde Einträge unverändert", () => {
  const source = skill(); sync();
  foreignLink("eigen", source);
  rmSync(source, { recursive: true });
  expect(lstatSync(join(dest, "tagesgruss")).isSymbolicLink()).toBe(true);
  sync();
  expect(readdirSync(dest)).toEqual(["eigen"]);
  expect(ledger().links).toEqual({});
});

test("Abschalten räumt nur eigene Links ab, leere Ablage und Zielordner bleiben", () => {
  const source = skill(); skill("abendgruss"); sync();
  foreignLink("eigen", source);
  expect(sync(false).linked).toEqual([]);
  expect(readdirSync(dest)).toEqual(["eigen"]);
  expect(ledger()).toEqual({ version: 1, links: {} });
  const before = statSync(ledgerPath).mtimeMs; sync(false);
  expect(statSync(ledgerPath).mtimeMs).toBe(before);
  expect(sync().linked).toEqual(["abendgruss", "tagesgruss"]);
});

for (const corrupt of [false, true]) test(`${corrupt ? "Kaputte" : "Gelöschte"} Ablage macht vorhandene Links fremd, auch bei Quellenwechsel`, () => {
  const source = skill(); sync();
  if (corrupt) writeFileSync(ledgerPath, "kaputt"); else unlinkSync(ledgerPath);
  skill("tagesgruss", root);
  expect(sync().foreign).toEqual(["tagesgruss"]);
  expect(readlinkSync(join(dest, "tagesgruss"))).toBe(source);
  sync(false);
  expect(readlinkSync(join(dest, "tagesgruss"))).toBe(source);
  if (corrupt) expect(log.mock.calls.some(c => String(c[0]).includes("Ablage unlesbar"))).toBe(true);
});

for (const present of [false, true]) test(`Vermerk ohne Link: Quelle ${present ? "vorhanden, Link erneuern" : "weg, Vermerk streichen"}`, () => {
  const source = skill(); sync();
  const saved = ledger(); saved.links.tagesgruss.createdAt = "2001-01-01T00:00:00.000Z";
  writeFileSync(ledgerPath, JSON.stringify(saved));
  unlinkSync(join(dest, "tagesgruss"));
  if (!present) rmSync(source, { recursive: true });
  sync();
  if (present) {
    expect(readlinkSync(join(dest, "tagesgruss"))).toBe(source);
    expect(ledger().links.tagesgruss.createdAt).not.toBe(saved.links.tagesgruss.createdAt);
  } else expect(ledger().links).toEqual({});
});

for (const parent of [".agents", ".agents/skills"]) for (const kind of ["Link", "Datei"]) {
  test(`${parent} ist ${kind}: weder Anlegen noch Entfernen noch Ablage ändern`, () => {
    skill(); sync();
    const before = readFileSync(ledgerPath, "utf8");
    const path = join(root, parent);
    rmSync(path, { recursive: true });
    const elsewhere = join(base, "geschuetzt"); mkdirSync(elsewhere);
    if (kind === "Link") symlinkSync(elsewhere, path, "dir"); else writeFileSync(path, "behalten");
    sync(); sync(false);
    expect(readFileSync(ledgerPath, "utf8")).toBe(before);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(log).toHaveBeenCalledTimes(2);
    if (kind === "Link") expect(readlinkSync(path)).toBe(elsewhere);
    else expect(readFileSync(path, "utf8")).toBe("behalten");
  });
}

test("Ablageordner als Link wird ebenfalls nicht zum Schreiben nach außen genutzt", () => {
  skill();
  symlinkSync(home, join(root, "data"), "dir");
  sync();
  expect(existsSync(join(home, "codex-skill-links.json"))).toBe(false);
  expect(existsSync(dest)).toBe(false);
});

test("Eigener Ablagepfad für Tests, ohne Standarddatei", () => {
  skill();
  const alternate = join(root, "testdaten", "links.json");
  syncCodexSkillLinks({ root, home, enabled: true, ledgerPath: alternate });
  expect(JSON.parse(readFileSync(alternate, "utf8")).links.tagesgruss).toBeDefined();
  expect(existsSync(ledgerPath)).toBe(false);
});

test.skipIf(process.getuid?.() === 0)("Fehlendes Schreibrecht: error statt Wurf; keine Ablage, keine Temp-Datei", () => {
  skill(); mkdirSync(dest, { recursive: true }); chmodSync(dest, 0o555);
  try {
    expect(sync()).toEqual({ linked: [], foreign: [], skipped: [{ name: "tagesgruss", reason: "error" }] });
    expect(existsSync(ledgerPath)).toBe(false);
    expect(readdirSync(dest)).toEqual([]);
  } finally { chmodSync(dest, 0o755); }
});

for (const own of ["home-agents", "codex-home", "project-codex", "system"]) test(`Codex-Konfiguration geht vor (${own}), auch mit abweichendem Kopf-Namen`, () => {
  skill("ordner", home, head("tagesgruss"));
  sync();
  const config = join(base, "codex-konfiguration");
  const folder = own === "home-agents" ? join(home, ".agents", "skills", "anders")
    : own === "project-codex" ? join(root, ".codex", "skills", "anders")
    : own === "system" ? join(config, "skills", ".system", "anders") : join(config, "skills", "anders");
  const text = head("tagesgruss"); file(join(folder, "SKILL.md"), text);
  const r = syncCodexSkillLinks({ root, home, enabled: true, codexHome: config });
  expect(r).toEqual({ linked: [], foreign: [], skipped: [{ name: "ordner", reason: "name" }] });
  expect(readdirSync(dest)).toEqual([]);
  expect(ledger().links).toEqual({});
  expect(readFileSync(join(folder, "SKILL.md"), "utf8")).toBe(text);
});

test("Standard-Konfigurationsordner liegt unter dem übergebenen Home; keine Doppelten nach Kopf-Namen", () => {
  skill("tagesgruss");
  file(join(home, ".codex", "skills", "eigen", "SKILL.md"), head());
  expect(sync().skipped).toEqual([{ name: "tagesgruss", reason: "name" }]);
  skill("eins", root, head("geteilt")); skill("zwei", home, head("geteilt"));
  const r = sync();
  expect(r.linked).toEqual(["eins"]);
  expect(r.skipped).toContainEqual({ name: "zwei", reason: "name" });
});

test("Ohne Quellen oder abgeschaltet und ohne Ablage wird nichts angelegt", () => {
  expect(sync()).toEqual({ linked: [], foreign: [], skipped: [] });
  skill(); sync(false);
  expect(readdirSync(root)).toEqual([]);
});

const inspect = (enabled = true) => inspectCodexSkillLinks({ root, home, enabled });

test("Nachsehen trennt Soll und Ist, auch nach manuellem Löschen und bei abgeschalteter Einstellung", () => {
  skill(); sync();
  const paths = [root, dest, dirname(dest), ledgerPath, dirname(ledgerPath)];
  const times = paths.map(p => statSync(p).mtimeMs);
  const before = readFileSync(ledgerPath, "utf8");
  log.mockClear();
  expect(inspect()).toEqual({ expected: ["tagesgruss"], linked: ["tagesgruss"], foreign: [], skipped: [] });
  expect(inspect(false)).toEqual({ expected: [], linked: ["tagesgruss"], foreign: [], skipped: [] });
  expect(paths.map(p => statSync(p).mtimeMs)).toEqual(times);
  expect(readFileSync(ledgerPath, "utf8")).toBe(before);
  unlinkSync(join(dest, "tagesgruss"));
  expect(inspect()).toEqual({ expected: ["tagesgruss"], linked: [], foreign: [], skipped: [] });
  expect(readFileSync(ledgerPath, "utf8")).toBe(before);
  expect(log).not.toHaveBeenCalled();
});

test("Nachsehen legt keinen Ordner an, liest Köpfe auch abgeschaltet und erkennt Kollisionen", () => {
  skill(); skill("ohne-kopf", home, "# Ohne Kopf"); skill("mit leerzeichen");
  skill("zweiter", root, head("tagesgruss"));
  const result = inspect();
  expect(result.expected).toEqual(["zweiter"]);
  expect(result.linked).toEqual([]);
  for (const item of [{ name: "tagesgruss", reason: "name" }, { name: "ohne-kopf", reason: "head" }, { name: "mit leerzeichen", reason: "name" }]) {
    expect(result.skipped).toContainEqual(item);
    expect(inspect(false).skipped).toContainEqual(item);
  }
  expect(inspect(false).expected).toEqual([]);
  expect(existsSync(join(root, ".agents"))).toBe(false);
  expect(existsSync(ledgerPath)).toBe(false);
  expect(log).not.toHaveBeenCalled();
});

test("Nachsehen übernimmt fremde Links und anders geschriebene Einträge nicht", () => {
  const source = skill(); foreignLink("Tagesgruss", source);
  const result = inspect();
  expect(result).toEqual({ expected: [], linked: [], foreign: ["Tagesgruss"], skipped: [] });
  expect(inspect(false)).toEqual(result);
  expect(existsSync(ledgerPath)).toBe(false);
  expect(log).not.toHaveBeenCalled();
});

test("Nachsehen berücksichtigt CODEX_HOME und meldet kaputte Ablage ohne Logzeile", () => {
  skill(); sync();
  const config = join(base, "codex-eigen");
  file(join(config, "skills", "anders", "SKILL.md"), head());
  expect(inspectCodexSkillLinks({ root, home, enabled: true, codexHome: config }).skipped)
    .toEqual([{ name: "tagesgruss", reason: "name" }]);
  file(ledgerPath, "kaputt");
  const before = statSync(ledgerPath).mtimeMs;
  expect(inspect().foreign).toEqual(["tagesgruss"]);
  expect(statSync(ledgerPath).mtimeMs).toBe(before);
  expect(log).not.toHaveBeenCalled();
});

test("Nachsehen: verschwundenes Ziel zählt nicht als eigener sichtbarer Link", () => {
  const source = skill(); sync(); rmSync(source, { recursive: true });
  expect(inspect().linked).toEqual([]);
  expect(lstatSync(join(dest, "tagesgruss")).isSymbolicLink()).toBe(true);
});

test("Nachsehen prüft alle Eigentumsbedingungen und zählt Dateien oder geänderte Ziele als fremd", () => {
  const source = skill(); sync();
  const path = join(dest, "tagesgruss");
  unlinkSync(path); file(join(path, "SKILL.md"), head());
  expect(inspect()).toEqual({ expected: [], linked: [], foreign: ["tagesgruss"], skipped: [] });
  rmSync(path, { recursive: true });
  const other = join(base, "anderer-skill"); file(join(other, "SKILL.md"), head());
  symlinkSync(other, path, "dir");
  expect(inspect()).toEqual({ expected: [], linked: [], foreign: ["tagesgruss"], skipped: [] });
  unlinkSync(path); symlinkSync(source, path, "dir");
  expect(inspect().linked).toEqual(["tagesgruss"]);
  unlinkSync(ledgerPath);
  expect(inspect()).toEqual({ expected: [], linked: [], foreign: ["tagesgruss"], skipped: [] });
  expect(log).not.toHaveBeenCalled();
});
