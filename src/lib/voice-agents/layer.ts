/**
 * Sprachschicht (Entscheidung 0026): was tybo von einem Anbieter für
 * Sprachagenten braucht. Die Typen nennen keine Anbieterdetails, damit später
 * ein zweiter Adapter dazukommen kann; heute gibt es elevenlabs.ts.
 *
 * Kein Aufruf wirft bei einem Fehler des Anbieters: Das Ergebnis trägt den
 * Fehler in Klartext, ohne Schlüssel und Tokens. vorlaeufig heißt, ein späterer
 * Versuch kann gelingen (Zeitablauf, 429, 5xx).
 */
import { z } from "zod";
import { VoiceAgentError } from "./base";
import type { Recipe } from "./recipe";
import type { VoiceAgentState } from "./state";

const testEntry = z.object({ id: z.string(), hash: z.string() });

/**
 * Prüft nur und gibt das Objekt unverändert weiter: z.record verwirft den
 * zulässigen Testnamen __proto__, die Kennung ginge verloren.
 */
function isTestRecord(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.values(value as object).every((entry) => testEntry.safeParse(entry).success);
}

const layerFields = z
  .object({
    /** Kennung des Rezepts, damit remove und runTests mit dem Zustand allein auskommen */
    kennung: z.string().optional(),
    /** Tests beim Anbieter je Name: Kennung und Hash des zuletzt übertragenen Inhalts */
    tests: z.custom<Record<string, { id: string; hash: string }>>(isTestRecord).optional(),
    /**
     * Letzter bekannter Stand beim Anbieter: je Feld ein Hash, nie der Wert. So
     * landet auch ein von Hand eingetragenes Geheimnis nicht in state.json.
     */
    anbieterStand: z.record(z.string()).optional(),
    /**
     * Geschrieben, aber noch nicht zurückgelesen: je Feld der Hash dessen, was
     * tybo gesendet hat. Scheitert die Nachfrage, ist das die Vergleichsgrundlage
     * des nächsten Abgleichs.
     */
    ausstehend: z.object({ stand: z.record(z.string()), hash: z.string(), eingabeHash: z.string() }).optional(),
    /** Agent, den ein neuer abgelöst hat und der beim Anbieter noch gelöscht werden muss */
    ersetzterAgentId: z.string().optional(),
    /** Hash aus Prompt und Brücke beim letzten Abgleich; beides ändert den Rezept-Hash nicht */
    eingabeHash: z.string().optional(),
    /** Verweis auf das beim Anbieter hinterlegte Token der Brücke, nicht das Token */
    brueckenGeheimnisId: z.string().optional(),
  })
  .passthrough();

export type VoiceLayerState = VoiceAgentState & z.infer<typeof layerFields>;

/** Prüft die Felder der Sprachschicht in einem gelesenen Zustand. */
export function parseLayerState(state: VoiceAgentState): VoiceLayerState {
  const parsed = layerFields.safeParse(state);
  if (!parsed.success) throw new VoiceAgentError("Der Zustand des Sprachagenten ist beschädigt: Felder der Sprachschicht passen nicht.");
  return { ...state, ...parsed.data };
}

export interface LayerFailure {
  status: "fehler";
  fehler: string;
  vorlaeufig: boolean;
}

export type DeployResult =
  | { status: "angelegt" | "geaendert" | "unveraendert"; state: VoiceLayerState; hinweise: string[] }
  /**
   * Der Agent weicht beim Anbieter ab oder der Stand lässt sich nicht prüfen;
   * nichts wurde überschrieben. felder nennt nur Namen, keine Werte. Weiter geht
   * es, wenn die Änderung beim Anbieter zurückgenommen ist oder nach remove.
   */
  | { status: "handaenderung"; state: VoiceLayerState; felder: string[]; warnung: string }
  | (LayerFailure & { state: VoiceLayerState | null });

export type SyncResult =
  | { status: "ok"; state: VoiceLayerState; angelegt: string[]; geaendert: string[]; entfernt: string[]; unveraendert: string[] }
  /** Was vor dem Fehler gelang, steht in state; ein neuer Aufruf macht nur den Rest. */
  | (LayerFailure & { state: VoiceLayerState | null });

export type RemoveResult = { status: "ok"; state: VoiceLayerState } | (LayerFailure & { state: VoiceLayerState | null });

/** Abweichungen nur für einen Testlauf, der Agent selbst bleibt unverändert */
export interface TestOverride {
  prompt?: string;
  ersterSatz?: string;
  /** Modell des Gehirns, das der Agent hat. Ein Wechsel der Gehirnart ist das nie. */
  modell?: string;
}

export type RunResult = { status: "gestartet"; runId: string } | LayerFailure;

/** erreichbar: Am Agenten beim Anbieter hängt eine Telefonnummer oder ein WhatsApp-Konto */
export type ReachableResult = { status: "ok"; erreichbar: boolean } | LayerFailure;

/** felder: Was beim Anbieter vom übergebenen Stand abweicht; leer heißt gleich */
export type StandResult = { status: "ok"; felder: string[] } | LayerFailure;

export interface DeployOptions {
  /**
   * Nur ändern, wenn am bestehenden Agenten beim Anbieter weder Telefonnummer
   * noch WhatsApp-Konto hängt (Issue #493): Eine ungeprüfte Fassung wäre dort
   * sofort erreichbar. Sonst ein Fehler ohne Schreibaufruf.
   */
  nurOhneZuordnung?: boolean;
  /**
   * Auch bei unverändertem Rezept-Hash beim Anbieter nachsehen, ob der Agent
   * noch dem letzten Abgleich entspricht (Issue #493, „Erneut versuchen“ nach
   * einem Testfehler). Eine Handänderung zwischen zwei Versuchen ergibt dann
   * handaenderung statt unveraendert.
   */
  standPruefen?: boolean;
}

export type TestStatus = "offen" | "bestanden" | "durchgefallen" | "abgebrochen";

export interface TestOutcome {
  testId: string;
  name: string;
  status: TestStatus;
  /** Begründung des Anbieters, wenn ein Test durchfiel */
  kriterium?: string;
}

export type TestRunResult =
  | { status: "fertig"; gesamt: "bestanden" | "durchgefallen" | "abgebrochen"; tests: TestOutcome[] }
  /** Die Frist lief ab, die Tests können beim Anbieter weiterlaufen. grund: letzter Fehler der Abfrage */
  | { status: "zeitueberschreitung"; tests: TestOutcome[]; grund?: string }
  | LayerFailure;

export interface VoiceLayer {
  /**
   * Legt den Agenten an oder ändert ihn. Ohne geänderten Rezept-Hash kein Aufruf
   * beim Anbieter. Entfällt eine Sprache, kann der Agent eine neue Kennung bekommen:
   * Maßgeblich ist state.agentId im Ergebnis.
   */
  deploy(recipe: Recipe, prompt: string, options?: DeployOptions): Promise<DeployResult>;
  /** Fragt beim Anbieter, ob der Agent über eine Nummer oder WhatsApp erreichbar ist. Ohne Agent: nicht erreichbar. */
  reachable(state: VoiceLayerState): Promise<ReachableResult>;
  /**
   * Vergleicht den Agenten beim Anbieter, nur lesend, mit einem früheren Stand
   * (anbieterStand nach deploy). Gibt es den Agenten nicht mehr, ist das eine
   * Abweichung; eine unlesbare Antwort ist ein Fehler, nie „gleich“.
   */
  compareStand(state: VoiceLayerState, stand: Record<string, string>): Promise<StandResult>;
  /** Entfernt Tests, Agent und hinterlegtes Token beim Anbieter. Das Rezept bleibt. */
  remove(state: VoiceLayerState): Promise<RemoveResult>;
  /** Bringt die Tests auf den Stand von Vorlage und Rezept. Ohne Änderung kein Aufruf. */
  syncTests(recipe: Recipe, state: VoiceLayerState): Promise<SyncResult>;
  /** Startet alle Tests des Agenten; runId bezeichnet den ganzen Lauf. */
  runTests(state: VoiceLayerState, override?: TestOverride): Promise<RunResult>;
  /** Fragt nach Zeitplan ab, bis der Lauf fertig ist oder die Frist abläuft. */
  testResult(runId: string): Promise<TestRunResult>;
}
