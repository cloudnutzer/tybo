/**
 * Tagesbudget für API-Aufrufe, Fassade auf spend/ledger.ts (Issue #313).
 * Namen, synchrone Signaturen und Fehlertexte bleiben für die Aufrufer gleich;
 * Speicherort, Tageswechsel und Regeln stehen in spend/ledger.ts.
 */
import { closeDailyHold, dailyRemainingUsd, holdDailyBudget } from "./spend/ledger";

/** Heute noch freier Betrag in Dollar */
export const remainingBudget = (): number => dailyRemainingUsd();

/** Reserviert vorab; wirft bei ausgeschöpftem Budget, ungültigem Betrag oder Speicherfehler */
export const reserveBudget = (provider: string, amount: number): string => holdDailyBudget(provider, amount);

/** Verbucht eine Reservierung mit den Istkosten (unbekannt: die Reservierung zählt) */
export const settleBudget = (id: string, actual?: number): void => closeDailyHold(id, actual);
