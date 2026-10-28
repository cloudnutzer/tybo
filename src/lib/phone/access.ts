/**
 * Zugang zum Anrufdienst für Befehl /anruf und Werkzeug phone_call
 * (Issue #367). Beide nutzen die eine PhoneService-Instanz aus dem Bot,
 * keinen eigenen Dienst. Der Zugang ergänzt den Namen aus dem Profil (sonst
 * begrüßt der Anruf mit „User") und nennt fehlende Einstellungen, nur die
 * Namen der Variablen.
 */

import type { ChoiceConversation } from "../choices";
import { createElevenLabsCaller } from "./provider";
import type { PhoneService, StartCallResult } from "./service";

type Env = Record<string, string | undefined>;

export interface PhoneAccess {
  /** Namen der fehlenden Variablen, leer heißt eingerichtet */
  missing(): string[];
  /** Anruf mit Anlass (leer: allgemeines Melden); Ergebnis wie startCall */
  call(reason: string, conversation: ChoiceConversation): Promise<StartCallResult>;
}

export interface PhoneAccessDeps {
  /** Name aus dem Profil; leer oder Fehler heißt ohne Namen */
  userName?(): Promise<string>;
  env?: Env;
}

export function phoneAccess(phone: Pick<PhoneService, "startCall">, deps: PhoneAccessDeps = {}): PhoneAccess {
  const env = deps.env ?? process.env;
  return {
    missing: () => createElevenLabsCaller({ env }).missing(),
    async call(reason, conversation) {
      const name = deps.userName ? await deps.userName().catch(() => "") : "";
      return phone.startCall({ reason, conversation, ...(name.trim() ? { userName: name.trim() } : {}) });
    },
  };
}
