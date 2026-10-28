/**
 * Datei-Adapter für Fakten und Ziele (Issue #316): das Gedächtnis ohne
 * Datenbank. Ablage wie bisher: MEMORY_FILE_PATH, sonst memory.json im
 * Projektordner (GO_PROJECT_ROOT bzw. Arbeitsordner). Gelesen und
 * geschrieben wird über updateJsonState (json-state.ts), also in
 * `<pfad>.sqlite`, je Änderung in einer Transaktion und damit sicher über
 * Prozessgrenzen (Bot, Sprach-Brücke). memory.json selbst dient nur noch
 * als Erstimport.
 *
 * Altbestand: Fakten als reine Texte und Ziele ohne ID bekommen beim ersten
 * Zugriff eine ID und bleiben sonst, wie sie sind; erledigte Ziele liegen
 * weiter unter completedGoals. Fakten und Ziele stehen in Anlage-Reihenfolge
 * (älteste zuerst), so wie der frühere Datei-Weg sie zeigte.
 *
 * Teiltext-Suchen vergleichen ohne Rücksicht auf Groß- und Kleinschreibung.
 * Vektoren gibt es hier keine (factVectors: null).
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { updateJsonState } from "../../json-state";
import type { MemoryStore } from "../ports";
import type { MemoryItem } from "../types";

interface StoredFact {
  id: string;
  text: string;
  createdAt?: string;
}

interface StoredGoal {
  id?: string;
  text: string;
  deadline?: string;
  createdAt?: string;
}

interface StoredDoneGoal {
  id?: string;
  text: string;
  completedAt: string;
}

/** Inhalt der Ablage; Fakten aus der Zeit vor #316 sind reine Texte */
interface StoredMemory {
  facts: (string | StoredFact)[];
  goals: StoredGoal[];
  completedGoals: StoredDoneGoal[];
}

/** Dieselbe Ablage mit IDs an jedem Fakt und offenen Ziel */
interface Memory {
  facts: StoredFact[];
  goals: (StoredGoal & { id: string })[];
  completedGoals: StoredDoneGoal[];
}

type Env = Record<string, string | undefined>;

/** Ort der Ablage aus der Umgebung */
export function memoryFilePath(env: Env = process.env): string {
  return env.MEMORY_FILE_PATH || join(env.GO_PROJECT_ROOT || process.cwd(), "memory.json");
}

const emptyMemory = (): StoredMemory => ({ facts: [], goals: [], completedGoals: [] });

/** Ergänzt fehlende Listen und IDs, auf demselben Objekt (es wird so gespeichert) */
function withIds(stored: StoredMemory): Memory {
  const memory = stored as unknown as Memory;
  const facts = Array.isArray(stored.facts) ? stored.facts : [];
  memory.facts = facts.map(fact => (typeof fact === "string" ? { id: randomUUID(), text: fact } : { ...fact, id: fact.id || randomUUID() }));
  memory.goals = (Array.isArray(stored.goals) ? stored.goals : []).map(goal => ({ ...goal, id: goal.id || randomUUID() }));
  if (!Array.isArray(stored.completedGoals)) memory.completedGoals = [];
  return memory;
}

const contains = (text: string, searchText: string) => text.toLowerCase().includes(searchText.toLowerCase());

const factItem = (fact: StoredFact): MemoryItem => ({
  id: fact.id,
  type: "fact",
  content: fact.text,
  ...(fact.createdAt ? { created_at: fact.createdAt } : {}),
});

const goalItem = (goal: StoredGoal & { id: string }): MemoryItem => ({
  id: goal.id,
  type: "goal",
  content: goal.text,
  completed: false,
  ...(goal.deadline ? { deadline: goal.deadline } : {}),
  ...(goal.createdAt ? { created_at: goal.createdAt } : {}),
});

/** Gültiger Zeitpunkt nach since? Ohne Zeitpunkt (Altbestand) nein */
function after(createdAt: string | undefined, since: number): boolean {
  const at = createdAt ? Date.parse(createdAt) : NaN;
  return at > since;
}

/**
 * Fakten und Ziele in der Datei. path wird bei jedem Zugriff gefragt; der
 * Store übergibt den Ort, der beim Wählen des Adapters galt.
 */
export function fileMemory(path: () => string): MemoryStore {
  const change = <T>(fn: (memory: Memory) => T): Promise<T> =>
    new Promise(resolve => resolve(updateJsonState(path(), emptyMemory, stored => fn(withIds(stored)))));

  /** Entfernt das offene Ziel an Stelle index; done: als erledigt ablegen */
  const takeGoal = (memory: Memory, index: number, done: boolean): boolean => {
    if (index < 0) return false;
    const [goal] = memory.goals.splice(index, 1);
    if (done) memory.completedGoals.push({ id: goal.id, text: goal.text, completedAt: new Date().toISOString() });
    return true;
  };
  const dropFact = (memory: Memory, index: number): boolean => {
    if (index < 0) return false;
    memory.facts.splice(index, 1);
    return true;
  };
  const firstGoal = (memory: Memory, searchText: string) => memory.goals.findIndex(goal => contains(goal.text, searchText));
  const firstFact = (memory: Memory, searchText: string) => memory.facts.findIndex(fact => contains(fact.text, searchText));

  return {
    addFact: content =>
      change(memory => {
        if (!memory.facts.some(fact => fact.text === content)) {
          memory.facts.push({ id: randomUUID(), text: content, createdAt: new Date().toISOString() });
        }
        return true;
      }),
    facts: () => change(memory => memory.facts.map(factItem)),
    deleteFact: searchText => change(memory => dropFact(memory, firstFact(memory, searchText))),
    addGoal: (content, deadline) => {
      let due: string | undefined;
      try {
        due = deadline?.toISOString();
      } catch {
        return Promise.resolve(false);
      }
      return change(memory => {
        memory.goals.push({ id: randomUUID(), text: content, ...(due ? { deadline: due } : {}), createdAt: new Date().toISOString() });
        return true;
      });
    },
    activeGoals: () => change(memory => memory.goals.map(goalItem)),
    completeGoal: searchText => change(memory => takeGoal(memory, firstGoal(memory, searchText), true)),
    cancelGoal: searchText => change(memory => takeGoal(memory, firstGoal(memory, searchText), false)),
    changedSince: since =>
      change(memory => {
        const cutoff = since.getTime();
        return [
          ...memory.facts.filter(fact => after(fact.createdAt, cutoff)).map(factItem),
          ...memory.goals.filter(goal => after(goal.createdAt, cutoff)).map(goalItem),
        ];
      }),
    factVectors: async () => null,
    matchingFacts: (searchText, limit) =>
      change(memory => memory.facts.filter(fact => contains(fact.text, searchText)).slice(0, limit).map(factItem)),
    matchingGoals: (searchText, limit) =>
      change(memory => memory.goals.filter(goal => contains(goal.text, searchText)).slice(0, limit).map(goalItem)),
    deleteFactById: id => change(memory => dropFact(memory, memory.facts.findIndex(fact => fact.id === id))),
    completeGoalById: id => change(memory => takeGoal(memory, memory.goals.findIndex(goal => goal.id === id), true)),
    cancelGoalById: id => change(memory => takeGoal(memory, memory.goals.findIndex(goal => goal.id === id), false)),
  };
}
