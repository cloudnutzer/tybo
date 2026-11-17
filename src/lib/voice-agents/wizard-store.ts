/**
 * Ablage des Wizards für Sprachagenten (Issue #514):
 * data/voice-agents/entwuerfe/<kennung>/wizard.json und anhaenge/.
 *
 * Zuordnung: Die Kennung im Pfad ist die Kennung des künftigen Agenten. Beim
 * Anlegen reserviert der Entwurfsdienst (drafts.ts reserveWizard) den Ordner
 * mit einem Entwurf in der Phase „wizard“ und schreibt dessen ID nach
 * entwurf-id, wie bei einem geprüften Entwurf aus /sprachagent neu.
 * wizard.json nennt dieselbe ID (entwurf). Nur wenn beide übereinstimmen und
 * der Entwurf diese Kennung trägt, gehört der Ordner diesem Wizard; sonst gilt
 * der Wizard als unbekannt. So verdrängt kein Wizard einen offenen Entwurf,
 * und ein Entwurf aus /sprachagent neu sieht die Kennung als belegt.
 *
 * Gleichzeitigkeit: Jede Änderung trägt die revision, die der Browser zuletzt
 * gelesen hat; eine veraltete wird abgelehnt. Alle schreibenden Wege laufen
 * nacheinander, im Prozess und über Prozesse per Datei-Sperre. Nach dem
 * Bauen (Phase nicht mehr „wizard“) lässt sich nichts mehr ändern; ein
 * zweites Bauen findet die Phase „job“ und wird abgelehnt.
 *
 * Letzter Schritt und Kennung (Issue #515): Der zuletzt bearbeitete Schritt
 * der Oberfläche steht als „schritt“ in wizard.json und kommt mit jedem
 * Speichern. Die Kennung ist ab dem ersten Speichern reserviert. Ändert der
 * Nutzer sie danach, zieht rename den Entwurf um: neue Kennung reservieren,
 * Felder, Satz, Schritt und Anhänge mitnehmen, die alte Reservierung
 * freigeben. Ist die neue Kennung vergeben oder belegt, bleibt alles unter
 * der alten, wie es war.
 *
 * Unfertige Eingaben (Prüfung von PR #558): Was noch keine gültige Vorgabe
 * ist (ein halber Link, Telefon ohne fertige Kennung der Nummer), steht als
 * „offen“ getrennt von felder. Jedes Speichern ersetzt es; Bauen lehnt ab,
 * solange davon etwas offen ist, ins Rezept geht es nie.
 *
 * Unterbrochenes Anlegen: Scheitert das Schreiben von wizard.json nach der
 * Reservierung, wird sie zurückgenommen. Nach einem Neustart dazwischen
 * übernimmt das nächste Anlegen sie, Verwerfen gibt sie frei.
 *
 * Symbolische Links: Ordner und Dateien müssen echt sein (base.ts), Dateien
 * werden ohne Folgen von Links gelesen. Die Kennung wird vorher geprüft, ein
 * Pfad wie ../x erreicht nie einen Ordner.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, rename as renamePath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteFile } from "../atomic-file";
import type { ChoiceConversation } from "../choices";
import { acquireFileLock, releaseFileLock } from "../file-lock";
import { agentsDataRoot, assertFileOrMissing, ensureRealDirs, readRegularFile, realDirsExist, VoiceAgentError, type VoiceAgentPaths } from "./base";
import { DRAFT_CONTROL_DIR, DRAFT_DIR, DRAFT_ID_PATTERN, DRAFT_OWNER_FILE, FINAL_PHASES, type DraftRecord, type DraftService } from "./drafts";
import { checkFields, checkFixed, isWizardKennung, missingForBuild, openForBuild, researchInputs, wizardFieldsSchema, wizardOpenSchema, wizardOverlay, wizardRequest, wizardVoice, WIZARD_SENTENCE_MAX, type WizardFields, type WizardOpenInputs } from "./wizard";

export const WIZARD_FILE = "wizard.json";
export const WIZARD_ATTACHMENT_DIR = "anhaenge";
export const WIZARD_ATTACHMENTS_MAX = 5;
export const WIZARD_PDF_MAX_BYTES = 10 * 1_048_576;
export const WIZARD_TEXT_MAX_BYTES = 1_048_576;
/** Schritte der Oberfläche (Issue #515); der zuletzt bearbeitete steht in wizard.json */
export const WIZARD_STEPS = 5;
const DATEI_PATTERN = /^a[0-9a-f]{8}\.(pdf|txt|md)$/;
const LOCK_WAIT_MS = 30_000;

const attachmentSchema = z
  .object({
    datei: z.string().regex(DATEI_PATTERN),
    name: z.string().min(1).max(120),
    mime: z.enum(["application/pdf", "text/plain", "text/markdown"]),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const fileSchema = z
  .object({
    version: z.literal(1),
    kennung: z.string(),
    entwurf: z.string().regex(DRAFT_ID_PATTERN),
    revision: z.number().int().min(1),
    erstelltAm: z.string(),
    geaendertAm: z.string(),
    satz: z.string().max(WIZARD_SENTENCE_MAX).optional(),
    /** Zuletzt bearbeiteter Schritt der Oberfläche; nur zum Fortsetzen */
    schritt: z.number().int().min(1).max(WIZARD_STEPS).optional(),
    felder: z.unknown(),
    /** Unfertige Eingaben (wizardOpenSchema): nur für die Oberfläche, nie im Rezept */
    offen: wizardOpenSchema.optional(),
    anhaenge: z.array(attachmentSchema).max(WIZARD_ATTACHMENTS_MAX),
  })
  .strict();

export type WizardAttachment = z.infer<typeof attachmentSchema>;

export interface WizardFile {
  version: 1;
  kennung: string;
  entwurf: string;
  revision: number;
  erstelltAm: string;
  geaendertAm: string;
  satz?: string;
  schritt?: number;
  felder: WizardFields;
  offen?: WizardOpenInputs;
  anhaenge: WizardAttachment[];
}

export interface WizardEntry {
  wizard: WizardFile;
  record: DraftRecord;
  /** Verstoß gegen feste Regeln in der Datei (von Hand geändert); Bauen lehnt dann ab */
  festFehler: string[];
}

export type WizardFailure =
  | { ok: false; code: "unbekannt" }
  | { ok: false; code: "ungueltig"; fehler: string[] }
  | { ok: false; code: "fest"; fehler: string[] }
  | { ok: false; code: "existiert" }
  | { ok: false; code: "vergeben" }
  | { ok: false; code: "belegt" }
  | { ok: false; code: "kennung" }
  | { ok: false; code: "veraltet"; revision: number }
  | { ok: false; code: "gebaut"; phase: string }
  | { ok: false; code: "unvollstaendig"; fehler: string[] }
  | { ok: false; code: "nur_revision" }
  | { ok: false; code: "zu_viele" }
  | { ok: false; code: "anhang_typ" }
  | { ok: false; code: "anhang_gross" }
  | { ok: false; code: "anhang_zahl" }
  | { ok: false; code: "anhang_leer" }
  | { ok: false; code: "anhang_unbekannt" }
  | { ok: false; code: "fehler"; fehler: string };

export type WizardOutcome<T> = { ok: true; value: T } | WizardFailure;

export interface WizardStoreDeps {
  drafts: Pick<DraftService, "reserveWizard" | "startWizard" | "discardWizard" | "read" | "ablageDir">;
  paths: VoiceAgentPaths;
  /** Wohin Rückfragen und Meldungen des Entwurfs gehen (im Bot der Direktchat) */
  conversation(): ChoiceConversation;
  now?(): number;
  log?(line: string): void;
}

const saveSchema = z
  .object({
    revision: z.number().int().min(1).optional(),
    satz: z.string().max(WIZARD_SENTENCE_MAX).optional(),
    schritt: z.number().int().min(1).max(WIZARD_STEPS).optional(),
    felder: z.unknown(),
    offen: wizardOpenSchema.optional(),
  })
  .strict();

/** Leere unfertige Eingaben zählen nicht: sie fehlen dann in wizard.json */
function openOrNone(offen: WizardOpenInputs | undefined): { offen?: WizardOpenInputs } {
  return offen && (offen.links?.length || offen.telefon) ? { offen } : {};
}
const buildSchema = z.object({ revision: z.number().int().min(1) }).strict();
const renameSchema = z.object({ revision: z.number().int().min(1), kennung: z.string() }).strict();

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/** Bytes einer normalen Datei ohne Folgen eines Links; null ohne Datei */
async function readRegularBytes(path: string): Promise<Uint8Array | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error: any) {
    if (error.code === "ENOENT") return null;
    throw new VoiceAgentError(`Keine normale Datei: ${path}`);
  }
  try {
    if (!(await handle.stat()).isFile()) throw new VoiceAgentError(`Keine normale Datei: ${path}`);
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}

/** PDF am Dateikopf, Text und Markdown an Endung und gültigem UTF-8 ohne Nullbytes */
export function detectWizardAttachment(name: string | undefined, bytes: Uint8Array): { ext: "pdf" | "txt" | "md"; mime: WizardAttachment["mime"]; max: number } | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 5));
  if (head === "%PDF-") return { ext: "pdf", mime: "application/pdf", max: WIZARD_PDF_MAX_BYTES };
  const ext = (name ?? "").toLowerCase().match(/\.(txt|md|markdown)$/)?.[1];
  if (!ext) return null;
  if (bytes.includes(0)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return ext === "txt" ? { ext: "txt", mime: "text/plain", max: WIZARD_TEXT_MAX_BYTES } : { ext: "md", mime: "text/markdown", max: WIZARD_TEXT_MAX_BYTES };
}

export interface WizardStore {
  get(kennung: string): Promise<WizardOutcome<WizardEntry>>;
  /** Offene Entwürfe; mit recentMs auch fertige und abgebrochene, die höchstens so lange zurückliegen */
  list(options?: { recentMs?: number }): Promise<WizardOutcome<WizardEntry[]>>;
  save(kennung: string, body: unknown): Promise<WizardOutcome<{ entry: WizardEntry; created: boolean }>>;
  remove(kennung: string): Promise<WizardOutcome<null>>;
  /** Kennung vor dem Bauen ändern: Felder, Satz, Schritt und Anhänge ziehen mit um (Issue #515) */
  rename(kennung: string, body: unknown): Promise<WizardOutcome<WizardEntry>>;
  addAttachment(kennung: string, name: string | undefined, bytes: Uint8Array): Promise<WizardOutcome<{ anhang: WizardAttachment; revision: number }>>;
  removeAttachment(kennung: string, datei: string): Promise<WizardOutcome<{ revision: number }>>;
  build(kennung: string, body: unknown): Promise<WizardOutcome<{ entwurf: string; jobId: string }>>;
}

export function createWizardStore(deps: WizardStoreDeps): WizardStore {
  const paths = deps.paths;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: string) => console.log(line));
  const iso = () => new Date(now()).toISOString();
  const draftsRoot = () => join(agentsDataRoot(paths), DRAFT_DIR);
  const lockFile = () => join(draftsRoot(), DRAFT_CONTROL_DIR, "wizard.lock");
  let chain: Promise<unknown> = Promise.resolve();

  /** Nacheinander im Prozess, über Prozesse per Datei-Sperre */
  async function locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(async () => {
      await ensureRealDirs([agentsDataRoot(paths), draftsRoot(), join(draftsRoot(), DRAFT_CONTROL_DIR)]);
      await assertFileOrMissing(lockFile());
      const owner = await acquireFileLock(lockFile(), { waitMs: LOCK_WAIT_MS });
      try {
        return await fn();
      } finally {
        await releaseFileLock(lockFile(), owner);
      }
    });
    chain = run.catch(() => {});
    return run;
  }

  /** Fehler der Ablage (Link, beschädigt) als Ergebnis, nie als Wurf */
  async function guarded<T>(what: string, fn: () => Promise<WizardOutcome<T>>): Promise<WizardOutcome<T>> {
    try {
      return await fn();
    } catch (e) {
      log(`[sprachagent] Wizard: ${what} gescheitert (${e instanceof Error ? e.name : "Fehler"})`);
      return { ok: false, code: "fehler", fehler: e instanceof VoiceAgentError ? e.message : "Details im Log" };
    }
  }

  const wizardFile = (kennung: string) => join(deps.drafts.ablageDir(kennung), WIZARD_FILE);
  const attachmentDir = (kennung: string) => join(deps.drafts.ablageDir(kennung), WIZARD_ATTACHMENT_DIR);

  async function readFile(kennung: string): Promise<{ wizard: WizardFile; festFehler: string[] } | null> {
    const content = await readRegularFile(wizardFile(kennung));
    if (content === null) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      throw new VoiceAgentError(`Wizard ${kennung} ist beschädigt`);
    }
    const parsed = fileSchema.safeParse(raw);
    const felder = parsed.success ? wizardFieldsSchema.safeParse(parsed.data.felder) : null;
    if (!parsed.success || !felder?.success || parsed.data.kennung !== kennung) throw new VoiceAgentError(`Wizard ${kennung} ist beschädigt`);
    // Gespeichert sind nur eigene Regeln; eine Datei, die feste Werte verletzt, ist von Hand geändert
    const festFehler = checkFixed({ ...felder.data, regeln: undefined });
    const checked = checkFields({ ...felder.data, regeln: undefined });
    const stored: WizardFields = checked.ok ? { ...checked.felder, ...(felder.data.regeln ? { regeln: felder.data.regeln.map((r) => (typeof r === "string" ? r : r.text)) } : {}) } : (felder.data as WizardFields);
    return { wizard: { ...parsed.data, felder: stored } as WizardFile, festFehler };
  }

  /** Der Wizard, dem der Ordner der Kennung gehört; null sonst */
  async function owned(kennung: string): Promise<WizardEntry | null> {
    if (!isWizardKennung(kennung)) return null;
    const dir = deps.drafts.ablageDir(kennung);
    if (!(await realDirsExist([agentsDataRoot(paths), draftsRoot(), dir]))) return null;
    const owner = (await readRegularFile(join(dir, DRAFT_OWNER_FILE)))?.trim() ?? "";
    if (!DRAFT_ID_PATTERN.test(owner)) return null;
    const file = await readFile(kennung);
    if (!file || file.wizard.entwurf !== owner) return null;
    const record = await deps.drafts.read(owner);
    if (!record || record.kennung !== kennung) return null;
    return { wizard: file.wizard, record, festFehler: file.festFehler };
  }

  /**
   * Reservierung ohne wizard.json: Das Anlegen wurde nach reserveWizard und vor
   * dem Schreiben unterbrochen (Schreibfehler, Neustart). Dann hält ein Entwurf
   * in der Phase „wizard“ die Kennung, ohne dass ein Wizard sie zeigt. Seine ID,
   * sonst null. Anlegen übernimmt sie, Verwerfen gibt sie frei.
   *
   * Liegt noch die wizard.json eines früheren Wizards derselben Kennung im
   * Ordner, zählt sie nur dann nicht, wenn ihr Entwurf diese Kennung trägt und
   * beendet ist. Nennt sie einen offenen oder unbekannten Entwurf, bleibt die
   * Reservierung unangetastet.
   */
  async function orphanReservation(kennung: string): Promise<string | null> {
    if (!isWizardKennung(kennung)) return null;
    const dir = deps.drafts.ablageDir(kennung);
    if (!(await realDirsExist([agentsDataRoot(paths), draftsRoot(), dir]))) return null;
    const owner = (await readRegularFile(join(dir, DRAFT_OWNER_FILE)))?.trim() ?? "";
    if (!DRAFT_ID_PATTERN.test(owner)) return null;
    const file = await readFile(kennung);
    if (file) {
      if (file.wizard.entwurf === owner) return null;
      const previous = await deps.drafts.read(file.wizard.entwurf);
      if (!previous || previous.kennung !== kennung || !FINAL_PHASES.includes(previous.phase)) return null;
    }
    const record = await deps.drafts.read(owner);
    return record && record.kennung === kennung && record.phase === "wizard" ? owner : null;
  }

  /** Der Anhangsordner muss ein echter Ordner sein, bevor etwas darin gelesen oder gelöscht wird; false ohne Ordner */
  const attachmentDirExists = (kennung: string) => realDirsExist([agentsDataRoot(paths), draftsRoot(), deps.drafts.ablageDir(kennung), attachmentDir(kennung)]);

  async function writeWizard(wizard: WizardFile): Promise<void> {
    await assertFileOrMissing(wizardFile(wizard.kennung));
    await atomicWriteFile(wizardFile(wizard.kennung), JSON.stringify(wizard, null, 2) + "\n");
  }

  async function editable(kennung: string): Promise<WizardEntry | WizardFailure> {
    const entry = await owned(kennung);
    if (!entry) return { ok: false, code: "unbekannt" };
    if (entry.record.phase !== "wizard") return { ok: false, code: "gebaut", phase: entry.record.phase };
    return entry;
  }

  const isFailure = (value: WizardEntry | WizardFailure): value is WizardFailure => "ok" in value;

  async function get(kennung: string): Promise<WizardOutcome<WizardEntry>> {
    return guarded("Lesen", async () => {
      const entry = await owned(kennung);
      return entry ? { ok: true, value: entry } : { ok: false, code: "unbekannt" };
    });
  }

  async function list(options: { recentMs?: number } = {}): Promise<WizardOutcome<WizardEntry[]>> {
    const recent = (entry: WizardEntry) =>
      options.recentMs !== undefined && entry.record.phase !== "verworfen" && now() - Date.parse(entry.record.geaendertAm) <= options.recentMs;
    return guarded("Liste", async () => {
      if (!(await realDirsExist([agentsDataRoot(paths), draftsRoot()]))) return { ok: true, value: [] };
      const out: WizardEntry[] = [];
      for (const name of (await readdir(draftsRoot())).filter(isWizardKennung).sort()) {
        try {
          const entry = await owned(name);
          if (entry && (!FINAL_PHASES.includes(entry.record.phase) || recent(entry))) out.push(entry);
        } catch {
          // beschädigt oder kein echter Ordner: gehört nicht in die Liste
        }
      }
      out.sort((a, b) => b.wizard.geaendertAm.localeCompare(a.wizard.geaendertAm));
      return { ok: true, value: out };
    });
  }

  async function save(kennung: string, body: unknown): Promise<WizardOutcome<{ entry: WizardEntry; created: boolean }>> {
    if (!isWizardKennung(kennung)) return { ok: false, code: "unbekannt" };
    const shape = saveSchema.safeParse(body);
    if (!shape.success) return { ok: false, code: "ungueltig", fehler: ["Erwartet { revision?, satz?, schritt?, felder, offen? }"] };
    const checked = checkFields(shape.data.felder);
    if (!checked.ok) return { ok: false, code: checked.status, fehler: checked.fehler };
    type Saved = WizardOutcome<{ entry: WizardEntry; created: boolean }>;
    return guarded("Speichern", () =>
      locked(async (): Promise<Saved> => {
        const at = iso();
        if (shape.data.revision === undefined) {
          const current = await owned(kennung);
          if (current && !FINAL_PHASES.includes(current.record.phase)) return { ok: false, code: "existiert" } as const;
          // Ein unterbrochenes Anlegen derselben Kennung wird übernommen statt als belegt abgelehnt
          const orphan = current ? null : await orphanReservation(kennung);
          let id: string;
          if (orphan) {
            id = orphan;
            log(`[sprachagent] Wizard ${kennung}: unterbrochenes Anlegen übernommen (Entwurf ${id})`);
          } else {
            const reserved = await deps.drafts.reserveWizard(kennung, deps.conversation());
            if (reserved.status !== "reserviert") return { ok: false, code: reserved.status } as const;
            id = reserved.id;
          }
          const satz = shape.data.satz?.trim();
          const schritt = shape.data.schritt;
          const wizard: WizardFile = { version: 1, kennung, entwurf: id, revision: 1, erstelltAm: at, geaendertAm: at, ...(satz ? { satz } : {}), ...(schritt ? { schritt } : {}), felder: checked.felder, ...openOrNone(shape.data.offen), anhaenge: [] };
          try {
            // Anhänge eines früheren, beendeten Wizards derselben Kennung gehören nicht zum neuen
            await rm(attachmentDir(kennung), { recursive: true, force: true });
            await writeWizard(wizard);
          } catch (e) {
            // Rücknahme: Sonst hielte der Entwurf die Kennung, ohne dass ein Wizard sie zeigt
            await deps.drafts.discardWizard(id).catch(() => false);
            throw e;
          }
          log(`[sprachagent] Wizard ${kennung}: angelegt (Entwurf ${id})`);
          const record = await deps.drafts.read(id);
          return { ok: true, value: { entry: { wizard, record: record!, festFehler: [] }, created: true } };
        }
        const entry = await editable(kennung);
        if (isFailure(entry)) return entry;
        if (entry.wizard.revision !== shape.data.revision) return { ok: false, code: "veraltet", revision: entry.wizard.revision } as const;
        // Fehlt satz, bleibt der alte; ein leerer Satz löscht ihn
        const satz = shape.data.satz === undefined ? entry.wizard.satz : shape.data.satz.trim();
        // Unfertige Eingaben schickt die Oberfläche bei jedem Speichern mit; fehlen sie, ist nichts offen
        const { satz: _previous, offen: _open, ...rest } = entry.wizard;
        // Fehlt schritt, bleibt der alte
        const schritt = shape.data.schritt ?? entry.wizard.schritt;
        const wizard: WizardFile = { ...rest, revision: entry.wizard.revision + 1, geaendertAm: at, felder: checked.felder, ...(satz ? { satz } : {}), ...(schritt ? { schritt } : {}), ...openOrNone(shape.data.offen) };
        await writeWizard(wizard);
        return { ok: true, value: { entry: { ...entry, wizard, festFehler: [] }, created: false } };
      }),
    );
  }

  async function remove(kennung: string): Promise<WizardOutcome<null>> {
    return guarded("Verwerfen", () =>
      locked(async () => {
        const entry = await editable(kennung);
        if (isFailure(entry)) {
          // Unterbrochenes Anlegen: die Reservierung freigeben, damit die Kennung nicht dauerhaft belegt bleibt
          const orphan = entry.code === "unbekannt" ? await orphanReservation(kennung) : null;
          if (!orphan) return entry;
          if (!(await deps.drafts.discardWizard(orphan))) return entry;
          await rm(attachmentDir(kennung), { recursive: true, force: true });
          log(`[sprachagent] Wizard ${kennung}: unterbrochenes Anlegen verworfen`);
          return { ok: true, value: null } as const;
        }
        if (!(await deps.drafts.discardWizard(entry.wizard.entwurf))) return { ok: false, code: "gebaut", phase: "unbekannt" } as const;
        await rm(attachmentDir(kennung), { recursive: true, force: true });
        await rm(wizardFile(kennung), { force: true });
        log(`[sprachagent] Wizard ${kennung}: verworfen`);
        return { ok: true, value: null } as const;
      }),
    );
  }

  async function rename(kennung: string, body: unknown): Promise<WizardOutcome<WizardEntry>> {
    const shape = renameSchema.safeParse(body);
    if (!shape.success) return { ok: false, code: "ungueltig", fehler: ["Erwartet { revision, kennung }"] };
    const target = shape.data.kennung;
    if (!isWizardKennung(target)) return { ok: false, code: "kennung" };
    return guarded("Umbenennen", () =>
      locked(async (): Promise<WizardOutcome<WizardEntry>> => {
        const entry = await editable(kennung);
        if (isFailure(entry)) return entry;
        if (entry.wizard.revision !== shape.data.revision) return { ok: false, code: "veraltet", revision: entry.wizard.revision } as const;
        if (target === kennung) return { ok: true, value: entry };
        const current = await owned(target);
        if (current && !FINAL_PHASES.includes(current.record.phase)) return { ok: false, code: "existiert" } as const;
        const reserved = await deps.drafts.reserveWizard(target, deps.conversation());
        if (reserved.status !== "reserviert") return { ok: false, code: reserved.status } as const;
        const wizard: WizardFile = { ...entry.wizard, kennung: target, entwurf: reserved.id, revision: entry.wizard.revision + 1, geaendertAm: iso() };
        let moved = false;
        try {
          // Anhänge eines früheren, beendeten Wizards der neuen Kennung gehören nicht dazu
          await rm(attachmentDir(target), { recursive: true, force: true });
          if (await attachmentDirExists(kennung)) {
            await renamePath(attachmentDir(kennung), attachmentDir(target));
            moved = true;
          }
          await writeWizard(wizard);
        } catch (e) {
          // Rücknahme: Der Entwurf bleibt unter der alten Kennung, wie er war
          if (moved) await renamePath(attachmentDir(target), attachmentDir(kennung)).catch(() => {});
          await deps.drafts.discardWizard(reserved.id).catch(() => false);
          throw e;
        }
        await deps.drafts.discardWizard(entry.wizard.entwurf).catch(() => false);
        await rm(wizardFile(kennung), { force: true });
        log(`[sprachagent] Wizard ${kennung}: Kennung geändert in ${target} (Entwurf ${reserved.id})`);
        const record = await deps.drafts.read(reserved.id);
        return { ok: true, value: { wizard, record: record!, festFehler: entry.festFehler } };
      }),
    );
  }

  async function addAttachment(kennung: string, name: string | undefined, bytes: Uint8Array): Promise<WizardOutcome<{ anhang: WizardAttachment; revision: number }>> {
    if (bytes.byteLength === 0) return { ok: false, code: "anhang_leer" };
    const type = detectWizardAttachment(name, bytes);
    if (!type) return { ok: false, code: "anhang_typ" };
    if (bytes.byteLength > type.max) return { ok: false, code: "anhang_gross" };
    return guarded("Anhang", () =>
      locked(async () => {
        const entry = await editable(kennung);
        if (isFailure(entry)) return entry;
        if (entry.wizard.anhaenge.length >= WIZARD_ATTACHMENTS_MAX) return { ok: false, code: "anhang_zahl" } as const;
        const datei = `a${randomBytes(4).toString("hex")}.${type.ext}`;
        const dir = attachmentDir(kennung);
        await ensureRealDirs([agentsDataRoot(paths), draftsRoot(), deps.drafts.ablageDir(kennung), dir]);
        await writeFile(join(dir, datei), bytes, { mode: 0o600, flag: "wx" });
        const anhang: WizardAttachment = { datei, name: (name ?? `datei.${type.ext}`).slice(0, 120), mime: type.mime, bytes: bytes.byteLength, sha256: sha256(bytes) };
        const wizard: WizardFile = { ...entry.wizard, revision: entry.wizard.revision + 1, geaendertAm: iso(), anhaenge: [...entry.wizard.anhaenge, anhang] };
        await writeWizard(wizard);
        return { ok: true, value: { anhang, revision: wizard.revision } } as const;
      }),
    );
  }

  async function removeAttachment(kennung: string, datei: string): Promise<WizardOutcome<{ revision: number }>> {
    if (!DATEI_PATTERN.test(datei)) return { ok: false, code: "anhang_unbekannt" };
    return guarded("Anhang entfernen", () =>
      locked(async () => {
        const entry = await editable(kennung);
        if (isFailure(entry)) return entry;
        if (!entry.wizard.anhaenge.some((a) => a.datei === datei)) return { ok: false, code: "anhang_unbekannt" } as const;
        // Vor der Änderung der Metadaten: Ordner und Datei echt, sonst bleibt alles, wie es ist
        const dirExists = await attachmentDirExists(kennung);
        if (dirExists) await assertFileOrMissing(join(attachmentDir(kennung), datei));
        const wizard: WizardFile = { ...entry.wizard, revision: entry.wizard.revision + 1, geaendertAm: iso(), anhaenge: entry.wizard.anhaenge.filter((a) => a.datei !== datei) };
        await writeWizard(wizard);
        if (dirExists) await rm(join(attachmentDir(kennung), datei), { force: true });
        return { ok: true, value: { revision: wizard.revision } } as const;
      }),
    );
  }

  async function build(kennung: string, body: unknown): Promise<WizardOutcome<{ entwurf: string; jobId: string }>> {
    const shape = buildSchema.safeParse(body);
    if (!shape.success) return { ok: false, code: "nur_revision" };
    return guarded("Bauen", () =>
      locked(async () => {
        const entry = await editable(kennung);
        if (isFailure(entry)) return entry;
        if (entry.wizard.revision !== shape.data.revision) return { ok: false, code: "veraltet", revision: entry.wizard.revision } as const;
        if (entry.festFehler.length) return { ok: false, code: "fest", fehler: entry.festFehler } as const;
        const felder = entry.wizard.felder;
        // Gebaut wird nur aus gültigen Vorgaben; steht noch eine unfertige Eingabe offen, fehlt etwas
        const missing = [...missingForBuild(felder), ...openForBuild(entry.wizard.offen, felder)];
        if (missing.length) return { ok: false, code: "unvollstaendig", fehler: missing } as const;
        const files = [];
        if (entry.wizard.anhaenge.length && !(await attachmentDirExists(kennung))) throw new VoiceAgentError("Anhänge fehlen");
        for (const a of entry.wizard.anhaenge) {
          const content = await readRegularBytes(join(attachmentDir(kennung), a.datei));
          if (!content || sha256(content) !== a.sha256) throw new VoiceAgentError(`Anhang ${a.name} fehlt oder wurde verändert`);
          files.push({ datei: a.datei, name: a.name, content });
        }
        // Recherche-Material nur beim Experten; geprüft werden die Anhänge trotzdem alle (Issue #515, Vorlagenwechsel)
        const research = felder.vorlage === "experte" ? files : [];
        const voice = wizardVoice(felder);
        const outcome = await deps.drafts.startWizard(entry.wizard.entwurf, {
          anfrage: wizardRequest(felder, entry.wizard.satz),
          vorgaben: { rezept: wizardOverlay(felder, kennung), ...researchInputs(felder), anhaenge: research.map(({ datei, name }) => ({ datei, name })), ...(voice ? { stimme: voice } : {}) },
          files: research,
        });
        switch (outcome.status) {
          case "gestartet":
            log(`[sprachagent] Wizard ${kennung}: Bauen gestartet (Entwurf ${outcome.id})`);
            return { ok: true, value: { entwurf: outcome.id, jobId: outcome.jobId } } as const;
          case "zu_viele":
            return { ok: false, code: "zu_viele" } as const;
          case "nicht_offen":
            return { ok: false, code: "gebaut", phase: "unbekannt" } as const;
          case "fehler":
          case "kaputt":
            return { ok: false, code: "fehler", fehler: outcome.fehler } as const;
          default:
            return { ok: false, code: "unvollstaendig", fehler: [`Beschreibung: ${outcome.status}`] } as const;
        }
      }),
    );
  }

  return { get, list, save, remove, rename, addAttachment, removeAttachment, build };
}
