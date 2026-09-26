/**
 * Schritt „profil“: Name und Zeitzone in .env (USER_NAME, USER_TIMEZONE)
 * und config/profile.md.
 *
 * Fehlt profile.md, entsteht sie aus den Angaben. Gibt es sie schon (oft von
 * Hand gepflegt), werden nur die Überschrift und die Zeilen „Zeitzone“ und
 * „Beruf“ angepasst oder, wenn sie fehlen, im Abschnitt „Über mich“ ergänzt;
 * vorher liegt eine Sicherung im Sicherungsordner.
 *
 * Geschrieben wird erst .env, dann profile.md. Scheitert profile.md, nennt
 * die Meldung, was in .env schon gespeichert ist.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../../lib/atomic-file";
import type { SetupContext } from "../context";
import {
  enteredValues,
  fieldStates,
  mergeValues,
  stateFromCount,
  type ApplyResult,
  type SetupField,
  type SetupStep,
  type SetupValues,
} from "../model";
import { enteredChanges, envValues, invalid, writeEnv, writeProblem } from "./common";

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("de-DE", { timeZone: tz });
    return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz);
  } catch {
    return false;
  }
}

export const PROFILE_FIELDS: SetupField[] = [
  {
    name: "USER_NAME",
    label: "Dein Name",
    kind: "text",
    required: true,
    help: "So spricht dich der Bot an.",
    validate: v => ([...v].length <= 80 ? null : "Name ist zu lang (höchstens 80 Zeichen)"),
  },
  {
    name: "USER_TIMEZONE",
    label: "Zeitzone",
    kind: "text",
    required: true,
    help: "IANA-Name wie Europe/Berlin oder America/New_York; wichtig für Erinnerungen und Briefing.",
    link: "https://en.wikipedia.org/wiki/List_of_tz_database_time_zones",
    validate: v => (isValidTimeZone(v) ? null : "Zeitzone unbekannt, Beispiel: Europe/Berlin"),
  },
  {
    name: "PROFESSION",
    label: "Beruf (optional)",
    kind: "text",
    help: "Hilft dem Bot, Antworten auf deine Arbeit zuzuschneiden. Steht nur in config/profile.md.",
    validate: v => ([...v].length <= 200 ? null : "Beruf ist zu lang (höchstens 200 Zeichen)"),
  },
];

const ENV_NAMES = ["USER_NAME", "USER_TIMEZONE"];
const PROFESSION_LINE = /^- (Beruf|Profession):[ \t]*(.*)$/m;
const TIMEZONE_LINE = /^- (Zeitzone|Timezone):.*$/m;
const ABOUT_HEADING = /^## (Über mich|About You|About me)\s*$/i;

async function readProfile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw e;
  }
}

/** Beruf aus profile.md, Platzhalter wie [e.g., ...] zählen nicht */
function professionOf(profile: string | null): string | undefined {
  const m = profile ? PROFESSION_LINE.exec(profile) : null;
  const v = m?.[2].trim();
  return v && !v.startsWith("[") ? v : undefined;
}

async function existingValues(ctx: SetupContext): Promise<{ values: SetupValues; profile: string | null }> {
  const values = await envValues(ctx, ENV_NAMES);
  const profile = await readProfile(ctx.profilePath);
  const profession = professionOf(profile);
  if (profession) values.PROFESSION = profession;
  return { values, profile };
}

/** Neue profile.md aus den Angaben */
export function renderProfile(v: SetupValues): string {
  const lines = [`# ${v.USER_NAME}`, "", "## Über mich"];
  if (v.PROFESSION) lines.push(`- Beruf: ${v.PROFESSION}`);
  lines.push(`- Zeitzone: ${v.USER_TIMEZONE}`, "", "## Kommunikation", "- Kurz und direkt antworten", "");
  return lines.join("\n");
}

/**
 * Fügt fehlende Zeilen in den Abschnitt „Über mich“ ein (nach Überschrift und
 * Hinweis-Kommentaren); gibt es den Abschnitt nicht, kommt er ans Ende.
 */
function insertAboutLines(profile: string, add: string[]): string {
  if (add.length === 0) return profile;
  const lines = profile.split("\n");
  const heading = lines.findIndex(l => ABOUT_HEADING.test(l));
  if (heading === -1) {
    const base = profile.replace(/\n*$/, "");
    return `${base}${base ? "\n\n" : ""}## Über mich\n${add.join("\n")}\n`;
  }
  let at = heading + 1;
  // Kommentare auch über mehrere Zeilen ganz überspringen, bis zur Zeile mit „-->“
  while (at < lines.length && lines[at].trim().startsWith("<!--")) {
    while (at < lines.length && !lines[at].includes("-->")) at++;
    at++;
  }
  lines.splice(at, 0, ...add);
  return lines.join("\n");
}

/**
 * Passt eine vorhandene profile.md an: Überschrift, Zeitzone, Beruf. Fehlt
 * eine dieser Zeilen, wird sie ergänzt; alles andere bleibt, wie es ist.
 */
export function updateProfile(profile: string, entered: SetupValues): string {
  let out = profile;
  if (entered.USER_NAME) {
    // Ersetzungsfunktion: „$&“ und ähnliche Zeichenfolgen im Namen bleiben wörtlich
    const heading = `# ${entered.USER_NAME}`;
    out = /^# .*$/m.test(out) ? out.replace(/^# .*$/m, () => heading) : `${heading}\n\n${out}`;
  }
  const add: string[] = [];
  if (entered.PROFESSION) {
    if (PROFESSION_LINE.test(out)) out = out.replace(PROFESSION_LINE, (_m, label) => `- ${label}: ${entered.PROFESSION}`);
    else add.push(`- Beruf: ${entered.PROFESSION}`);
  }
  if (entered.USER_TIMEZONE) {
    if (TIMEZONE_LINE.test(out)) out = out.replace(TIMEZONE_LINE, m => m.replace(/:.*$/, `: ${entered.USER_TIMEZONE}`));
    else add.push(`- Zeitzone: ${entered.USER_TIMEZONE}`);
  }
  return insertAboutLines(out, add);
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/** saved: was vorher schon gespeichert wurde, für eine ehrliche Fehlermeldung */
async function writeProfile(ctx: SetupContext, before: string | null, next: string, saved: string[]): Promise<ApplyResult> {
  if (before === next) return { ok: true, message: "", changed: [] };
  try {
    if (before !== null) {
      await mkdir(ctx.backupDir, { recursive: true, mode: 0o700 });
      const backup = join(ctx.backupDir, `profile-${stamp(ctx.now())}.md`);
      await writeFile(backup, before, { mode: 0o600, flag: "wx" });
      await chmod(backup, 0o600);
    }
    await atomicWriteFile(ctx.profilePath, next);
    return { ok: true, message: "", changed: [ctx.profilePath] };
  } catch (e) {
    return { ok: false, message: writeProblem("config/profile.md", e, saved), changed: [] };
  }
}

export const profileStep: SetupStep = {
  id: "profil",
  title: "Profil",
  description: "Wer du bist und wo du lebst, damit Antworten und Zeiten passen.",
  optional: false,
  fields: PROFILE_FIELDS,

  async status(ctx) {
    const { values, profile } = await existingValues(ctx);
    const done = ENV_NAMES.filter(n => values[n]).length + (profile !== null ? 1 : 0);
    const state = stateFromCount(done, ENV_NAMES.length + 1);
    const detail =
      state === "erledigt"
        ? "Name, Zeitzone und config/profile.md sind vorhanden."
        : state === "fehlt"
          ? "Noch kein Profil angelegt."
          : [!values.USER_NAME && "Name fehlt", !values.USER_TIMEZONE && "Zeitzone fehlt", profile === null && "config/profile.md fehlt"]
              .filter(Boolean)
              .join(", ") + ".";
    return { state, detail, fields: fieldStates(PROFILE_FIELDS, values) };
  },

  async apply(values, ctx) {
    const { values: existing, profile } = await existingValues(ctx);
    const problem = invalid(PROFILE_FIELDS, values, existing);
    if (problem) return { ...problem, changed: [] };
    const merged = mergeValues(existing, values);

    const env = await writeEnv(ctx, enteredChanges(PROFILE_FIELDS.filter(f => ENV_NAMES.includes(f.name)), values, merged));
    if (!env.ok) return env;
    const next = profile === null ? renderProfile(merged) : updateProfile(profile, enteredValues(values));
    const file = await writeProfile(ctx, profile, next, env.changed.length ? [`.env (${env.changed.join(", ")})`] : []);
    if (!file.ok) return { ...file, changed: env.changed };
    const changed = [...env.changed, ...file.changed];
    return { ok: true, message: changed.length ? "Gespeichert." : "Schon so eingetragen, nichts geändert.", changed };
  },
};
