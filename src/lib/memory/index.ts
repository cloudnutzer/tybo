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
  getMemorySelection,
  listFacts,
  listGoals,
  MAX_CHOICE_ENTRIES,
  memoryFailureText,
  openGoals,
  processIntents,
  reportMemoryFailures,
  setMemoryAsker,
  setMemoryFailureNotice,
} from "./service";
export type { AmbiguousMatch, IntentConversation, MemoryAsker, MemoryFailureNotice, OpenGoals, ProcessedIntents, SearchAction } from "./service";
