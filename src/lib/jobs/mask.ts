/**
 * Geheimnisse aus Job-Meldungen und Job-Logs fernhalten (Issue #103).
 *
 * Alles, was ein Job meldet (Titel, Bericht, Log-Auszug), geht vor dem
 * Versand durch maskSecrets. Die Outbox hält den Text so fest, wie sie ihn
 * bekommt, deshalb muss vorher maskiert werden. Die Ausgabe von Claude
 * läuft schon beim Schreiben nach job.log durch createStreamMasker, auch
 * wenn ein Geheimnis über mehrere Ausgabestücke verteilt ankommt.
 *
 * Maskiert werden, unabhängig von der Länge und überall, wo sie im Text
 * stehen, auch mitten in einem Wort:
 * - aus der .env jeder Wert;
 * - aus der Prozess-Umgebung die Werte geheim benannter Variablen
 *   (isSecretName).
 * Kurze Werte (true, 5) treffen so auch harmlose Stellen; das ist gewollt,
 * denn kein Wert aus der .env darf in einer Meldung stehen.
 *
 * Vor dem Maskieren fallen unsichtbare Zeichen weg (stripInvisibleChars wie
 * beim Telegram-Versand), sonst setzte die Bereinigung dort ein durch
 * U+200B getrenntes Geheimnis wieder zusammen.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvContent } from "../env-file";
import { isSecretName } from "../subprocess-env";
import { stripInvisibleChars } from "../telegram";

type Env = Record<string, string | undefined>;

export const MASK = "[verborgen]";

/** Ein Wert, der nie in einer Meldung oder einem Log stehen darf */
export type SecretValue = string;

export function secretValues(dotenv: Env, processEnv: Env = {}): SecretValue[] {
  const values = new Set<string>();
  const add = (raw: string | undefined) => {
    if (typeof raw !== "string" || raw.trim() === "") return;
    values.add(raw);
    values.add(raw.trim());
  };
  for (const value of Object.values(dotenv)) add(value);
  for (const [name, value] of Object.entries(processEnv)) if (isSecretName(name)) add(value);
  // Längste zuerst: ein Wert, der einen anderen enthält, wird ganz ersetzt
  return [...values].sort((a, b) => b.length - a.length);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Matcher {
  regex: RegExp;
  /** Länge des längsten Werts */
  hold: number;
}

function matcher(values: readonly SecretValue[]): Matcher | null {
  const list = values.filter(v => v !== "");
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => b.length - a.length);
  return { regex: new RegExp(sorted.map(escapeRegExp).join("|"), "gu"), hold: sorted[0].length };
}

/** Text ohne unsichtbare Zeichen und ohne die Werte */
export function maskSecrets(text: string, values: readonly SecretValue[]): string {
  const clean = stripInvisibleChars(text);
  const m = matcher(values);
  return m ? clean.replace(m.regex, MASK) : clean;
}

export interface StreamMasker {
  /** Nimmt ein Ausgabestück an und gibt zurück, was schon sicher geschrieben werden darf */
  push(chunk: string): string;
  /** Rest am Ende der Ausgabe */
  end(): string;
}

/**
 * Maskiert eine Ausgabe, die in Stücken ankommt. Zurückgehalten wird immer
 * nur so viel vom Ende, wie der längste Wert braucht; ein Geheimnis, das
 * über zwei Stücke verteilt ist, wird so trotzdem erkannt. Ergebnis
 * insgesamt wie maskSecrets auf der ganzen Ausgabe, nur bleiben unsichtbare
 * Zeichen stehen (die Datei ist lokal; was aus ihr gemeldet oder gezeigt
 * wird, geht erneut durch maskSecrets).
 */
export function createStreamMasker(values: readonly SecretValue[]): StreamMasker {
  const m = matcher(values);
  if (!m) return { push: chunk => chunk, end: () => "" };
  const { regex, hold } = m;
  let pending = "";

  const take = (final: boolean): string => {
    const text = pending;
    const limit = final ? text.length : text.length - hold;
    let pos = 0;
    let out = "";
    regex.lastIndex = 0;
    for (let match = regex.exec(text); match; match = regex.exec(text)) {
      // Ein Treffer, der erst hinter der Grenze beginnt, könnte noch länger werden
      if (!final && match.index >= limit) break;
      out += text.slice(pos, match.index) + MASK;
      pos = match.index + match[0].length;
    }
    const until = Math.max(pos, limit);
    out += text.slice(pos, until);
    pending = text.slice(until);
    return out;
  };

  return {
    push(chunk) {
      pending += chunk;
      return take(false);
    },
    end() {
      return take(true);
    },
  };
}

/** .env eines Projektordners; fehlt sie, leer */
export function readDotenv(root: string): Env {
  try {
    return parseEnvContent(readFileSync(join(root, ".env"), "utf8"));
  } catch {
    return {};
  }
}

/** Zu maskierende Werte: .env des Projekts und geheim benannte Variablen der Umgebung */
export function projectSecrets(root: string, processEnv: Env = process.env): SecretValue[] {
  return secretValues(readDotenv(root), processEnv);
}

/**
 * Wie projectSecrets, aber nur eine fehlende .env gilt als leer. Andere
 * Lesefehler (keine Rechte, Ordner statt Datei) werfen, damit der Aufrufer
 * nicht mit einer unvollständigen Liste maskiert.
 */
export function projectSecretsOrThrow(root: string, processEnv: Env = process.env): SecretValue[] {
  let content = "";
  try {
    content = readFileSync(join(root, ".env"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return secretValues(parseEnvContent(content), processEnv);
}
