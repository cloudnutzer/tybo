import { updateJsonState } from "./json-state";
import { atomicWriteFile } from "./atomic-file";
/**
 * Memory Module
 *
 * Unified memory layer with Supabase as primary store and local
 * JSON file as fallback. Provides facts, goals, and intent parsing
 * from Claude responses.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import {
  addFact as sbAddFact,
  addGoal as sbAddGoal,
  completeGoal as sbCompleteGoal,
  deleteFact as sbDeleteFact,
  cancelGoal as sbCancelGoal,
  getActiveGoals as sbGetActiveGoals,
  getFacts as sbGetFacts,
  getMemoryContext as sbGetMemoryContext,
  isSupabaseEnabled,
  parseRelativeDate,
  formatGoalsList,
  formatFactsList,
} from "./convex";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Goal {
  text: string;
  deadline?: string;
  createdAt: string;
}

interface CompletedGoal {
  text: string;
  completedAt: string;
}

interface Memory {
  facts: string[];
  goals: Goal[];
  completedGoals: CompletedGoal[];
}

// ---------------------------------------------------------------------------
// Local File Fallback
// ---------------------------------------------------------------------------

const MEMORY_PATH =
  process.env.MEMORY_FILE_PATH ||
  join(process.env.GO_PROJECT_ROOT || process.cwd(), "memory.json");

const DEFAULT_MEMORY: Memory = {
  facts: [],
  goals: [],
  completedGoals: [],
};

function mutateLocalMemory<T>(update: (memory: Memory) => T): T {
  return updateJsonState(MEMORY_PATH, () => ({ facts: [], goals: [], completedGoals: [] } as Memory), update);
}
async function readLocalMemory(): Promise<Memory> {
  return mutateLocalMemory(memory => memory);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Store a fact. Uses Supabase if available, otherwise local file.
 */
async function addFactUnlocked(content: string): Promise<boolean> {
  if (isSupabaseEnabled()) {
    return sbAddFact(content);
  }

  return mutateLocalMemory(memory => {
  if (memory.facts.includes(content)) return true; // Deduplicate
  memory.facts.push(content);
  return true;
  });
}

/**
 * Add a goal with an optional deadline (natural language supported).
 * Uses Supabase if available, otherwise local file.
 */
async function addGoalUnlocked(
  text: string,
  deadline?: string
): Promise<boolean> {
  if (isSupabaseEnabled()) {
    return sbAddGoal(text, deadline);
  }

  return mutateLocalMemory(memory => {
  const parsedDeadline = deadline ? parseRelativeDate(deadline) : undefined;
  memory.goals.push({
    text,
    deadline: parsedDeadline,
    createdAt: new Date().toISOString(),
  });
  return true;
  });
}

/**
 * Mark a goal as completed by partial text match.
 * Uses Supabase if available, otherwise local file.
 */
async function completeGoalUnlocked(searchText: string): Promise<boolean> {
  if (isSupabaseEnabled()) {
    return sbCompleteGoal(searchText);
  }

  return mutateLocalMemory(memory => {
  const lower = searchText.toLowerCase();
  const index = memory.goals.findIndex((g) =>
    g.text.toLowerCase().includes(lower)
  );

  if (index === -1) return false;

  const [removed] = memory.goals.splice(index, 1);
  memory.completedGoals.push({
    text: removed.text,
    completedAt: new Date().toISOString(),
  });
  return true;
  });
}

/**
 * Delete a fact by partial text match.
 * Uses Supabase if available, otherwise local file.
 */
async function deleteFactUnlocked(searchText: string): Promise<boolean> {
  if (isSupabaseEnabled()) {
    return sbDeleteFact(searchText);
  }

  return mutateLocalMemory(memory => {
  const lower = searchText.toLowerCase();
  const index = memory.facts.findIndex((f) =>
    f.toLowerCase().includes(lower)
  );

  if (index === -1) return false;

  memory.facts.splice(index, 1);
  return true;
  });
}

/**
 * Cancel (delete) a goal by partial text match.
 * Unlike completeGoal, this removes the goal entirely.
 * Uses Supabase if available, otherwise local file.
 */
async function cancelGoalUnlocked(searchText: string): Promise<boolean> {
  if (isSupabaseEnabled()) {
    return sbCancelGoal(searchText);
  }

  return mutateLocalMemory(memory => {
  const lower = searchText.toLowerCase();
  const index = memory.goals.findIndex((g) =>
    g.text.toLowerCase().includes(lower)
  );

  if (index === -1) return false;

  memory.goals.splice(index, 1);
  return true;
  });
}

/**
 * List all active goals. Returns formatted string.
 */
export async function listGoals(): Promise<string> {
  if (isSupabaseEnabled()) {
    const goals = await sbGetActiveGoals();
    return formatGoalsList(goals);
  }

  const memory = await readLocalMemory();
  if (memory.goals.length === 0) return "No active goals.";

  return memory.goals
    .map((g, i) => {
      const deadline = g.deadline
        ? ` (due: ${new Date(g.deadline).toLocaleDateString()})`
        : "";
      return `${i + 1}. ${g.text}${deadline}`;
    })
    .join("\n");
}

/**
 * List all stored facts. Returns formatted string.
 */
export async function listFacts(): Promise<string> {
  if (isSupabaseEnabled()) {
    const facts = await sbGetFacts();
    return formatFactsList(facts);
  }

  const memory = await readLocalMemory();
  if (memory.facts.length === 0) return "No stored facts.";
  return memory.facts.map((f) => `- ${f}`).join("\n");
}

/**
 * Build combined memory context (facts + goals) for prompt injection.
 * userMessage enables relevance ranking when facts exceed the char budget.
 */
export async function getMemoryContext(userMessage?: string): Promise<string> {
  if (isSupabaseEnabled()) {
    return sbGetMemoryContext(userMessage);
  }

  const memory = await readLocalMemory();
  const sections: string[] = [];

  if (memory.facts.length > 0) {
    sections.push(
      `**Known Facts:**\n${memory.facts.map((f) => `- ${f}`).join("\n")}`
    );
  }

  if (memory.goals.length > 0) {
    const goalLines = memory.goals
      .map((g, i) => {
        const deadline = g.deadline
          ? ` (due: ${new Date(g.deadline).toLocaleDateString()})`
          : "";
        return `${i + 1}. ${g.text}${deadline}`;
      })
      .join("\n");
    sections.push(`**Active Goals:**\n${goalLines}`);
  }

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Intent Processing
// ---------------------------------------------------------------------------

export interface ProcessedIntents {
  goalsAdded: string[];
  goalsCompleted: string[];
  goalsCancelled: string[];
  factsAdded: string[];
  factsRemoved: string[];
}

/**
 * Parse and process structured intent tags from Claude responses.
 *
 * Recognized tags:
 *   [GOAL: description | DEADLINE: deadline]   - Add a new goal
 *   [GOAL: description]                        - Add a goal without deadline
 *   [DONE: partial match text]                 - Complete an existing goal
 *   [CANCEL: partial match text]               - Cancel/delete a goal
 *   [REMEMBER: fact text]                      - Store a fact
 *   [FORGET: partial match text]               - Delete a stored fact
 *
 * Returns a summary of what was processed.
 */
export async function processIntents(
  text: string
): Promise<ProcessedIntents> {
  const result: ProcessedIntents = {
    goalsAdded: [],
    goalsCompleted: [],
    goalsCancelled: [],
    factsAdded: [],
    factsRemoved: [],
  };

  // [GOAL: description | DEADLINE: deadline]
  const goalWithDeadline =
    /\[GOAL:\s*([^|\]]+?)\s*\|\s*DEADLINE:\s*([^\]]+?)\s*\]/gi;
  let match: RegExpExecArray | null;

  while ((match = goalWithDeadline.exec(text)) !== null) {
    const goalText = match[1].trim();
    const deadline = match[2].trim();
    const success = await addGoal(goalText, deadline);
    if (success) result.goalsAdded.push(goalText);
  }

  // [GOAL: description] (without deadline, avoid re-matching the above)
  const goalSimple = /\[GOAL:\s*([^\]|]+?)\s*\]/gi;
  while ((match = goalSimple.exec(text)) !== null) {
    const goalText = match[1].trim();
    // Skip if already added via the deadline pattern
    if (result.goalsAdded.includes(goalText)) continue;
    const success = await addGoal(goalText);
    if (success) result.goalsAdded.push(goalText);
  }

  // [DONE: text] — require minimum 5 chars to prevent vague matches
  const donePattern = /\[DONE:\s*([^\]]+?)\s*\]/gi;
  while ((match = donePattern.exec(text)) !== null) {
    const doneText = match[1].trim();
    if (doneText.length < 5) {
      console.warn(`[INTENT] Skipping vague DONE tag: "${doneText}"`);
      continue;
    }
    console.log(`[INTENT] Processing DONE: "${doneText}"`);
    const success = await completeGoal(doneText);
    if (success) result.goalsCompleted.push(doneText);
  }

  // [REMEMBER: text]
  const rememberPattern = /\[REMEMBER:\s*([^\]]+?)\s*\]/gi;
  while ((match = rememberPattern.exec(text)) !== null) {
    const factText = match[1].trim();
    const success = await addFact(factText);
    if (success) result.factsAdded.push(factText);
  }

  // [FORGET: text]
  const forgetPattern = /\[FORGET:\s*([^\]]+?)\s*\]/gi;
  while ((match = forgetPattern.exec(text)) !== null) {
    const forgetText = match[1].trim();
    const success = await deleteFact(forgetText);
    if (success) result.factsRemoved.push(forgetText);
  }

  // [CANCEL: text] — require minimum 5 chars to prevent vague matches
  const cancelPattern = /\[CANCEL:\s*([^\]]+?)\s*\]/gi;
  while ((match = cancelPattern.exec(text)) !== null) {
    const cancelText = match[1].trim();
    if (cancelText.length < 5) {
      console.warn(`[INTENT] Skipping vague CANCEL tag: "${cancelText}"`);
      continue;
    }
    console.log(`[INTENT] Processing CANCEL: "${cancelText}"`);
    const success = await cancelGoal(cancelText);
    if (success) result.goalsCancelled.push(cancelText);
  }

  return result;
}

export function addFact(...args: Parameters<typeof addFactUnlocked>): Promise<boolean> {
  return serializeMemory(() => addFactUnlocked(...args));
}

export function addGoal(...args: Parameters<typeof addGoalUnlocked>): Promise<boolean> {
  return serializeMemory(() => addGoalUnlocked(...args));
}

export function completeGoal(...args: Parameters<typeof completeGoalUnlocked>): Promise<boolean> {
  return serializeMemory(() => completeGoalUnlocked(...args));
}

export function deleteFact(...args: Parameters<typeof deleteFactUnlocked>): Promise<boolean> {
  return serializeMemory(() => deleteFactUnlocked(...args));
}

export function cancelGoal(...args: Parameters<typeof cancelGoalUnlocked>): Promise<boolean> {
  return serializeMemory(() => cancelGoalUnlocked(...args));
}

let memoryTail: Promise<unknown> = Promise.resolve();
function serializeMemory<T>(fn: () => Promise<T>): Promise<T> {
  const pending = memoryTail.catch(() => {}).then(fn);
  memoryTail = pending;
  return pending;
}
