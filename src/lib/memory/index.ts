/**
 * Einstieg ins Gedächtnis (Issue #316): `import … from "./memory"` landet
 * hier. Der Dienst steht in service.ts, der Tag-Parser in intents.ts.
 */
export {
  addFact,
  addGoal,
  applyToEntry,
  cancelGoal,
  completeGoal,
  deleteFact,
  getMemoryContext,
  listFacts,
  listGoals,
  MAX_CHOICE_ENTRIES,
  openGoals,
  processIntents,
  setMemoryAsker,
} from "./service";
export type { AmbiguousMatch, IntentConversation, MemoryAsker, OpenGoals, ProcessedIntents, SearchAction } from "./service";
