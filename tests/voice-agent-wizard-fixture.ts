/**
 * Attrappen für den Wizard (Issue #514): echter Entwurfsdienst mit Job- und
 * Sprachschicht-Attrappe (voice-agents-drafts-fixture.ts), echter Web-Server,
 * Nebenmodell als Funktion. Kein Modellaufruf, kein Anbieter, kein src/bot.ts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PRICE_BASIS, type PriceLoad } from "../src/lib/voice-agents/cost";
import type { ProposalAsk } from "../src/lib/voice-agents/wizard";
import { createVoiceAgentWizard, type WizardSpeak } from "../src/web/bot-voice-agent-wizard";
import type { ProviderVoice } from "../src/lib/voice-agents/voice-catalog";
import type { WebServer } from "../src/web/server";
import { topicServer } from "./topic-fixture";
import { DM, draftHarness, type DraftHarness } from "./voice-agents-drafts-fixture";

export const servers: WebServer[] = [];
const roots: string[] = [];

export async function stopWizardServers(): Promise<void> {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
}

export function removeWizardRoots(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export interface WizardHarness {
  h: DraftHarness;
  wizard: ReturnType<typeof createVoiceAgentWizard>;
  ctx: Awaited<ReturnType<typeof topicServer>>;
  asks: string[];
  /** Antwort des Nebenmodells; Tests setzen sie je Fall */
  answer: { value: ProposalAsk };
  prices: { value: PriceLoad };
  logs: string[];
}

export async function wizardHarness(
  options: { now?: () => number; proposalTimeoutMs?: number; standardVoice?: string | null; voices?: ProviderVoice[] | (() => Promise<ProviderVoice[]>); speak?: WizardSpeak; probeTimeoutMs?: number; withLayer?: boolean } = {},
): Promise<WizardHarness> {
  const root = mkdtempSync(join(tmpdir(), "wizard-server-"));
  roots.push(root);
  const h = draftHarness({ standardVoice: options.standardVoice, ...(options.withLayer === false ? { withLayer: false } : {}) });
  const asks: string[] = [];
  const logs: string[] = [];
  const answer: { value: ProposalAsk } = { value: async () => ({ text: "", isError: true }) };
  const prices: { value: PriceLoad } = { value: { status: "ok", basis: DEFAULT_PRICE_BASIS, eigene: false } };
  const wizard = createVoiceAgentWizard({
    drafts: h.service,
    paths: h.paths,
    ask: async (prompt, timeoutMs) => {
      asks.push(prompt);
      return answer.value(prompt, timeoutMs);
    },
    conversation: () => DM,
    prices: async () => prices.value,
    voiceSources: () => (h.standard ? { setting: h.standard } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.proposalTimeoutMs ? { proposalTimeoutMs: options.proposalTimeoutMs } : {}),
    ...(options.voices ? { voices: typeof options.voices === "function" ? options.voices : async () => options.voices as ProviderVoice[] } : {}),
    ...(options.speak ? { speak: options.speak } : {}),
    ...(options.probeTimeoutMs ? { probeTimeoutMs: options.probeTimeoutMs } : {}),
    log: (line) => void logs.push(line),
  });
  const ctx = await topicServer(root, servers, null, { voiceAgentWizard: wizard });
  return { h, wizard, ctx, asks, answer, prices, logs };
}

/** Gültige Antwort des Nebenmodells für eine Kochhilfe */
export const GOOD_PROPOSAL = {
  vorlage: "jarvis",
  name: "Kochhilfe Küche",
  zweck: "Liest Rezepte vor und hilft beim Kochen.",
  persona: { rolle: "Geduldige Köchin", anrede: "du", sprachen: ["de"], ersterSatz: "Was kochen wir heute?" },
  regeln: ["Nennt Mengen in Gramm"],
  gedaechtnis: "keins",
};

/** Felder für einen vollständigen Entwurf, wie die Oberfläche sie schickt */
export function kitchenFields(change: (f: any) => void = () => {}): any {
  const f: any = {
    vorlage: "jarvis",
    name: "Kochhilfe",
    zweck: "Liest Rezepte vor.",
    persona: { rolle: "Köchin", anrede: "du", sprachen: ["de"], ersterSatz: "Was kochen wir?" },
    gedaechtnis: "keins",
    gehirn: { art: "anbieter", modell: "claude-haiku-5-5" },
    zugang: { web: true, maxMinuten: 10, minutenMonat: 100, anrufeJeNummerTag: 0 },
  };
  change(f);
  return f;
}
