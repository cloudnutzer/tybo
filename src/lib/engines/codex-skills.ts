/** Skills von Claude Code für Codex verlinken (M14-13, Entscheidung 0027). */
import { randomUUID } from "node:crypto";
import {
  closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  readlinkSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface CodexSkillLinksInput {
  root: string;
  home: string;
  enabled: boolean;
  ledgerPath?: string;
  /** Nur lesend; der Aufrufer berücksichtigt CODEX_HOME, Tests bleiben im Temp-Ordner. */
  codexHome?: string;
}

export interface CodexSkillLinksResult {
  linked: string[];
  foreign: string[];
  skipped: { name: string; reason: "name" | "head" | "error" }[];
}

interface LinkRecord { target: string; createdAt: string }
interface Ledger { version: 1; links: Record<string, LinkRecord> }
interface Skill { name: string; target: string; modelName: string }

export const NAME = /^(?!\.)[A-Za-z0-9._-]{1,64}(?![\s\S])/;
const HEAD_BYTES = 8 * 1024;
const reportedForeign = new Set<string>();
const key = (name: string) => name.toLowerCase();
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const emptyLedger = (): Ledger => ({ version: 1, links: Object.create(null) });
const warn = () => console.error("[Codex] Skill-Links konnten nicht vollständig abgeglichen werden.");

function entry(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); } catch (error) {
    if (code(error) !== "ENOENT") throw error;
  }
}

/** Keine Schreiboperation darf einem Link in den Zielverzeichnissen folgen. */
function directory(path: string, create = false): void {
  const info = entry(path);
  if (info) {
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsicherer Zielordner");
  } else if (create) {
    mkdirSync(path);
  }
}

function readLedger(path: string, onError = () => console.error("[Codex] Skill-Link-Ablage unlesbar; vorhandene Einträge bleiben fremd.")): Ledger {
  try {
    const info = entry(path);
    if (!info) return emptyLedger();
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("keine Ablagedatei");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw?.version !== 1 || !raw.links || typeof raw.links !== "object" || Array.isArray(raw.links)) throw new Error("ungültige Ablage");
    const ledger = emptyLedger();
    const names = new Set<string>();
    for (const [name, value] of Object.entries(raw.links)) {
      const link = value as LinkRecord;
      if (!NAME.test(name) || names.has(key(name)) || typeof link?.target !== "string" || !isAbsolute(link.target)
        || typeof link.createdAt !== "string" || !Number.isFinite(Date.parse(link.createdAt))) throw new Error("ungültiger Vermerk");
      names.add(key(name));
      ledger.links[name] = { target: link.target, createdAt: link.createdAt };
    }
    return ledger;
  } catch {
    onError();
    return emptyLedger();
  }
}

/** Nur den begrenzten Dateianfang lesen, niemals den Skill-Inhalt umschreiben. */
function skillHead(path: string): { name?: string } | undefined {
  let fd: number | undefined;
  try {
    if (!statSync(path).isFile()) return;
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8").replace(/^\uFEFF/, "");
    const lines = text.split(/\r?\n/);
    if (lines[0] !== "---") return;
    const end = lines.findIndex((line, index) => index > 0 && line === "---");
    if (end < 0) return;
    const head = Bun.YAML.parse(lines.slice(1, end).join("\n")) as Record<string, unknown> | null;
    if (!head || typeof head.description !== "string" || !head.description.trim()) return;
    if (head.name !== undefined && (typeof head.name !== "string" || !head.name.trim())) return;
    return { name: typeof head.name === "string" ? head.name.trim() : undefined };
  } catch { return; } finally { if (fd !== undefined) closeSync(fd); }
}

function children(path: string): string[] {
  try { return readdirSync(path).sort(); } catch (error) {
    if (code(error) === "ENOENT") return [];
    throw error;
  }
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch (error) {
    if (code(error) === "ENOENT") return false;
    throw error;
  }
}

function sources(root: string, home: string, result: CodexSkillLinksResult): Skill[] {
  const found = new Map<string, Skill>();
  const seen = new Set<string>();
  for (const base of [join(root, ".claude", "skills"), join(home, ".claude", "skills")]) {
    for (const name of children(base)) {
      const target = join(base, name);
      if (!isDirectory(target)) continue; // stat folgt auch verlinkten Quellordnern.
      if (!NAME.test(name)) { result.skipped.push({ name, reason: "name" }); continue; }
      if (seen.has(key(name))) continue;
      if (!entry(join(target, "SKILL.md"))) { result.skipped.push({ name, reason: "head" }); continue; }
      seen.add(key(name)); // Auch ein ungültiger Projekt-Skill geht seinem Home-Namensvetter vor.
      const head = skillHead(join(target, "SKILL.md"));
      if (!head) { result.skipped.push({ name, reason: "head" }); continue; }
      found.set(key(name), { name, target, modelName: head.name ?? name });
    }
  }
  return [...found.values()];
}

/** Codex listet gleiche Kopf-Namen mehrfach. Die eigene Konfiguration geht vor. */
function ownSkillNames(paths: string[]): Set<string> {
  const names = new Set<string>();
  const visited = new Set<string>();
  const visit = (path: string, depth: number) => {
    if (depth > 32) throw new Error("Skill-Verzeichnis zu tief");
    let info: ReturnType<typeof statSync>;
    try { info = statSync(path); } catch (error) { if (code(error) === "ENOENT") return; throw error; }
    if (!info.isDirectory()) return;
    const identity = `${info.dev}:${info.ino}`;
    if (visited.has(identity)) return;
    visited.add(identity);
    const head = skillHead(join(path, "SKILL.md"));
    if (head) names.add(key(head.name ?? basename(path)));
    for (const name of children(path)) {
      if (!name.startsWith(".") || name === ".system") visit(join(path, name), depth + 1);
    }
  };
  for (const path of paths) visit(path, 0);
  return names;
}

function owned(path: string, link: LinkRecord | undefined): boolean {
  return !!link && !!entry(path)?.isSymbolicLink() && readlinkSync(path) === link.target;
}

/** Quellen, Kopf-Kollisionen und Eigentum werden beim Abgleich und Nachsehen gleich ausgewertet. */
function skillSources(input: CodexSkillLinksInput, result: CodexSkillLinksResult) {
  return {
    skills: sources(resolve(input.root), resolve(input.home), result),
    ownNames: ownSkillNames([
      join(input.home, ".agents", "skills"), join(input.codexHome ?? join(input.home, ".codex"), "skills"),
      join(input.root, ".codex", "skills"),
    ]),
  };
}

function linkEntry(skill: Skill, dest: string, ledger: Ledger, existing: Map<string, string>) {
  const recordName = Object.keys(ledger.links).find(name => key(name) === key(skill.name));
  const name = existing.get(key(skill.name)) ?? recordName ?? skill.name;
  const path = join(dest, name);
  // Andere Großschreibung überträgt niemals das Eigentum eines Nutzer-Eintrags.
  const record = recordName === name ? ledger.links[name] : undefined;
  const info = entry(path);
  return { name, path, recordName, record, info, isOwn: owned(path, record) };
}

function nameCollision(skill: Skill, ownNames: Set<string>, effective: Set<string>): boolean {
  if (ownNames.has(key(skill.modelName)) || effective.has(key(skill.modelName))) return true;
  effective.add(key(skill.modelName));
  return false;
}

export interface CodexSkillLinksInspection {
  expected: string[];
  linked: string[];
  foreign: string[];
  skipped: { name: string; reason: "name" | "head" }[];
}

/** Nur lesen: auch abgeschaltet bleiben noch vorhandene eigene Links sichtbar. */
export function inspectCodexSkillLinks(input: CodexSkillLinksInput, onReadError = () => {}): CodexSkillLinksInspection {
  const result: CodexSkillLinksInspection = { expected: [], linked: [], foreign: [], skipped: [] };
  const dest = join(resolve(input.root), ".agents", "skills");
  const ledger = readLedger(resolve(input.ledgerPath ?? join(input.root, "data", "codex-skill-links.json")), onReadError);
  let safeDestination = true;
  try { directory(dirname(dest)); directory(dest); } catch { safeDestination = false; onReadError(); }
  const existing = new Map((safeDestination ? children(dest) : []).map(name => [key(name), name]));
  for (const name of existing.values()) {
    const path = join(dest, name);
    if (owned(path, ledger.links[name]) && isDirectory(path)) {
      try { if (statSync(join(path, "SKILL.md")).isFile()) result.linked.push(name); }
      catch (error) { if (code(error) !== "ENOENT") onReadError(); }
    }
  }
  const { skills, ownNames } = skillSources(input, result);
  const effective = new Set<string>();
  for (const skill of skills) {
    const item = safeDestination ? linkEntry(skill, dest, ledger, existing) : undefined;
    if (item?.info && !item.isOwn) { result.foreign.push(item.name); continue; }
    if (nameCollision(skill, ownNames, effective)) { result.skipped.push({ name: skill.name, reason: "name" }); continue; }
    if (input.enabled) result.expected.push(item?.name ?? skill.name);
  }
  return result;
}

function atomicLedger(path: string, ledger: Ledger): void {
  const temp = join(dirname(path), `.codex-skill-links-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(ledger, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally { if (entry(temp)) unlinkSync(temp); }
}

/**
 * Synchroner Abgleich: Start und Chat im selben Prozess können sich nicht
 * überschneiden. Jobs lesen den Stand des letzten Abgleichs, sie schreiben nie.
 * Ein verlorener Vermerk wird nie aus einem passenden Linkziel rekonstruiert.
 */
export function syncCodexSkillLinks(input: CodexSkillLinksInput): CodexSkillLinksResult {
  const result: CodexSkillLinksResult = { linked: [], foreign: [], skipped: [] };
  const root = resolve(input.root);
  const agents = join(root, ".agents");
  const dest = join(agents, "skills");
  const ledgerPath = resolve(input.ledgerPath ?? join(root, "data", "codex-skill-links.json"));
  let skills: Skill[] = [];
  try {
    directory(agents);
    directory(dest);
    // Die Ablage darf ebenfalls nicht durch einen Nutzer-Link nach außen schreiben.
    // /var kann auf macOS selbst ein Link sein: nur unterhalb des gewählten Roots prüfen.
    const ledgerParent = dirname(ledgerPath);
    const checkLedgerParent = (create = false) => {
      if (ledgerParent === root) return;
      const parts = relative(root, ledgerParent).split(sep);
      if (parts[0] === ".." || isAbsolute(relative(root, ledgerParent))) {
        directory(ledgerParent, create);
        return;
      }
      let path = root;
      for (const part of parts) { path = join(path, part); directory(path, create); }
    };
    checkLedgerParent();
    if (entry(ledgerPath)?.isSymbolicLink()) throw new Error("verlinkte Ablage");
    const ledger = readLedger(ledgerPath);
    const before = JSON.stringify(ledger);
    const evaluated = input.enabled ? skillSources(input, result) : { skills: [], ownNames: new Set<string>() };
    skills = evaluated.skills;
    const { ownNames } = evaluated;
    const desired = new Set<string>();
    const effective = new Set<string>();
    const foreign = (name: string) => {
      result.foreign.push(name);
      const id = join(dest, key(name));
      if (!reportedForeign.has(id)) {
        reportedForeign.add(id);
        console.error(`[Codex] Skill ${name}: im Projekt selbst vorhanden.`);
      }
    };
    const existing = new Map(children(dest).map(name => [key(name), name]));

    for (const skill of skills) {
      let name = skill.name;
      try {
        const item = linkEntry(skill, dest, ledger, existing);
        name = item.name;
        const { path, recordName, record, info, isOwn } = item;
        if (recordName && !isOwn) delete ledger.links[recordName];
        if (info && !isOwn) { foreign(name); continue; }
        if (nameCollision(skill, ownNames, effective)) {
          result.skipped.push({ name: skill.name, reason: "name" });
          continue;
        }
        desired.add(key(name));
        if (!info) {
          directory(agents, true);
          directory(dest, true);
          symlinkSync(skill.target, path, "dir");
        } else if (record!.target !== skill.target) {
          const temp = join(dest, `.tybo-skill-${randomUUID()}`);
          try {
            symlinkSync(skill.target, temp, "dir");
            if (!owned(path, record)) throw new Error("Link inzwischen geändert");
            renameSync(temp, path);
          } finally { if (entry(temp)) unlinkSync(temp); }
        } else { result.linked.push(name); continue; }
        // Erst der Link, dann der Vermerk: ein Absturz hinterlässt einen fremden Link.
        ledger.links[name] = { target: skill.target, createdAt: new Date().toISOString() };
        result.linked.push(name);
      } catch (error) {
        if (code(error) === "EEXIST") { foreign(name); }
        else { result.skipped.push({ name: skill.name, reason: "error" }); warn(); }
      }
    }

    for (const [name, link] of Object.entries(ledger.links)) {
      const path = join(dest, name);
      try {
        if (!owned(path, link)) { delete ledger.links[name]; continue; }
        if (desired.has(key(name))) continue;
        unlinkSync(path);
        delete ledger.links[name];
      } catch { warn(); }
    }
    if (before !== JSON.stringify(ledger)) {
      checkLedgerParent(true);
      atomicLedger(ledgerPath, ledger);
    }
  } catch {
    warn();
    for (const skill of skills) {
      if (!result.linked.includes(skill.name) && !result.skipped.some(s => s.name === skill.name)) result.skipped.push({ name: skill.name, reason: "error" });
    }
  }
  return result;
}
