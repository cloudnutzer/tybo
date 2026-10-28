/**
 * Rückfragen-Register für Tests (Issue #115): das echte Register aus
 * src/lib/choices.ts mit eigener Datei im Temp-Verzeichnis und ein
 * ChoicePort darauf, dessen 15-Sekunden-Abgleich der Test selbst auslöst.
 */
import { readFile, writeFile } from "node:fs/promises";
import {
  createChoice,
  decideChoice,
  getChoiceChecked,
  listChoices,
  onChoiceChange,
  setChoicesFileForTests,
  type Choice,
  type CreateChoiceInput,
} from "../src/lib/choices";
import { createChoicePort, type ChoicePort, type ChoiceRegister } from "../src/web/choices";

export const register: ChoiceRegister = { get: getChoiceChecked, list: listChoices, decide: decideChoice, onChange: onChoiceChange };

export interface TestChoices {
  port: ChoicePort;
  file: string;
  /** Abgleich auslösen wie der Zeitgeber alle 15 Sekunden */
  tick(): Promise<void>;
  /** Abstand, mit dem der Port den Zeitgeber gestellt hat */
  intervals: number[];
  create(input: Partial<CreateChoiceInput> & Pick<CreateChoiceInput, "conversation">): Promise<Choice>;
  /** Wie ein anderer Prozess: Datei direkt ändern, ohne Zuhörer dieses Prozesses */
  editFile(fn: (choices: Record<string, any>) => void): Promise<void>;
}

export function useChoiceFile(file: string): void {
  setChoicesFileForTests(file);
}

export function testChoices(file: string, deps: { userId?: string; groupId?: string | null } = {}): TestChoices {
  setChoicesFileForTests(file);
  const ticks: (() => Promise<void>)[] = [];
  const intervals: number[] = [];
  const port = createChoicePort({
    register,
    userId: deps.userId,
    groupId: () => deps.groupId ?? null,
    every: (ms, fn) => {
      intervals.push(ms);
      ticks.push(fn);
      return () => {
        const i = ticks.indexOf(fn);
        if (i >= 0) ticks.splice(i, 1);
      };
    },
    log: () => {},
  });
  return {
    port,
    file,
    intervals,
    async tick() {
      for (const fn of [...ticks]) await fn();
    },
    create: input =>
      createChoice({
        kind: "tool",
        text: "Werkzeug ausführen?",
        options: [
          { key: "ok", label: "Erlauben" },
          { key: "no", label: "Ablehnen" },
        ],
        ...input,
      }),
    async editFile(fn) {
      const data = JSON.parse(await readFile(file, "utf8"));
      fn(data.choices);
      await writeFile(file, JSON.stringify(data, null, 2));
    },
  };
}
