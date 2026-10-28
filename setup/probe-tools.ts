/**
 * Probe der Werkzeuge für Ersatzmodelle (Issue #332), von Hand gestartet:
 *
 *   bun run test:tools [Optionen]
 *
 * Ersetzt die früheren Handproben für MCP-Server, Built-in-Werkzeuge,
 * Fallback mit Werkzeugen und Telegram-Formatierung. Ohne Optionen läuft nur,
 * was nichts sendet und nichts kostet, außer lesenden Aufrufen bei Diensten,
 * deren Schlüssel in der .env stehen (Firecrawl-Scrape von example.com,
 * Cloudflare-Projektliste):
 *
 *   1. Built-ins: registriert, verfügbar, mit Freigabe
 *   2. MCP: Server verbinden, beide Werkzeugformate gleich lang, keine
 *      doppelten Namen
 *   3. Werkzeugaufrufe: Firecrawl direkt, Cloudflare über den Manager, das
 *      erste MCP-Werkzeug aus MCP_READ_ONLY_TOOLS über den Manager, und zwar
 *      beim dort genannten Server; bestanden nur, wenn der Server geantwortet
 *      hat, auch mit Werkzeugfehler oder JSON-RPC-Fehlerantwort (verweigerte
 *      Freigabe, Zeitlimit, fehlende oder abgebrochene Verbindung: Fehler)
 *   4. Telegram-Formatierung lokal: Auszeichnung, Sonderzeichen, lange
 *      Nachricht in Stücken bis 4000 Zeichen mit geschlossenen Tags
 *
 * Optionen (kosten Geld oder senden etwas):
 *   --fallback  echtes Ersatzmodell (OpenRouter, sonst Ollama) muss ein
 *               lesendes Werkzeug aus PROBE_READ_TOOLS erfolgreich aufrufen;
 *               andere Werkzeugnamen werden abgelehnt; dazu eine Frage durch
 *               die ganze Kette mit Gesprächskontext
 *   --telegram  schickt die Formatierungsbeispiele an TELEGRAM_USER_ID
 *   --apify     ein kleiner Apify-Lauf (kostet Credits)
 *   --send      eine Testdatei über telegram_send_document
 *   --alles     alle vier
 *
 * Exitcode: 0 alle gelaufenen Prüfungen bestanden (übersprungene zählen
 * nicht), 1 mindestens eine fehlgeschlagen, 2 unbekannte Option.
 */
import { BRAND, OPENROUTER_APP_HEADERS } from "../src/brand";
import { renderTelegram, TELEGRAM_TEXT_MAX } from "../src/channels/telegram/format";
import type { OpenAITool, ToolCallResult } from "../src/lib/mcp/manager";

export const PROBE_OPTIONS = ["--fallback", "--telegram", "--apify", "--send", "--alles"] as const;
export type ProbeOption = "fallback" | "telegram" | "apify" | "send";

/** Optionen aus der Befehlszeile; unbekannte landen in unknown */
export function parseProbeArgs(argv: string[]): { options: Set<ProbeOption>; unknown: string[] } {
  const options = new Set<ProbeOption>();
  const unknown: string[] = [];
  for (const arg of argv) {
    if (arg === "--alles") for (const o of ["fallback", "telegram", "apify", "send"] as const) options.add(o);
    else if ((PROBE_OPTIONS as readonly string[]).includes(arg)) options.add(arg.slice(2) as ProbeOption);
    else unknown.push(arg);
  }
  return { options, unknown };
}

/** Beispiele für die Formatierung, auch für den Versand mit --telegram */
export const FORMAT_SAMPLES: { name: string; markdown: string }[] = [
  {
    name: "Auszeichnung",
    markdown: "**Fett**, *kursiv*, `code_mit_unterstrich` und ~~durchgestrichen~~.\n\n> Ein Zitat\n\n[Ein Link mit_unterstrich](https://example.com/pfad_mit_unterstrich)",
  },
  {
    name: "Sonderzeichen",
    markdown: "Vergleich a < b && c > d, HTML `<div>` und <b>roh</b>, Umlaute äöü ß, Emoji ✅, Bezeichner user_id und file_path.\n\n```ts\nif (a < b && b > c) console.log(\"<ok>\");\n```",
  },
  {
    name: "Lange Nachricht",
    markdown: Array.from({ length: 60 }, (_, i) => `**Absatz ${i + 1}:** ${"Ein Satz zum Füllen der Nachricht. ".repeat(4)}`).join("\n\n"),
  },
];

/** Tags eines Stücks: alle geöffneten wieder geschlossen, in richtiger Reihenfolge */
function tagsBalanced(html: string): boolean {
  const stack: string[] = [];
  for (const match of html.matchAll(/<(\/?)([a-z-]+)(?:\s[^>]*)?>/gi)) {
    const [, closing, tag] = match;
    if (!closing) stack.push(tag.toLowerCase());
    else if (stack.pop() !== tag.toLowerCase()) return false;
  }
  return stack.length === 0;
}

/** Prüft ein Beispiel lokal; leere Liste heißt bestanden */
export function formatProblems(sample: { name: string; markdown: string }): string[] {
  const problems: string[] = [];
  const chunks = renderTelegram(sample.markdown);
  if (chunks.length === 0) problems.push("keine Ausgabe");
  chunks.forEach((chunk, i) => {
    if (chunk.length > TELEGRAM_TEXT_MAX) problems.push(`Stück ${i + 1} hat ${chunk.length} Zeichen`);
    if (!tagsBalanced(chunk)) problems.push(`Stück ${i + 1} hat offene Tags`);
  });
  const all = chunks.join("");
  if (all.includes("<div>")) problems.push("<div> nicht maskiert");
  if (sample.markdown.length > TELEGRAM_TEXT_MAX && chunks.length < 2) problems.push("lange Nachricht nicht geteilt");
  return problems;
}

// ---------------------------------------------------------------------------
// Bewertung der Werkzeugaufrufe
// ---------------------------------------------------------------------------

export type Outcome = "ok" | "fehler" | "übersprungen";
export interface Verdict {
  outcome: Outcome;
  detail: string;
}

/** 0 alle gelaufenen Prüfungen bestanden, 1 mindestens eine fehlgeschlagen */
export function probeExitCode(outcomes: Outcome[]): number {
  return outcomes.includes("fehler") ? 1 : 0;
}

const FAILURE_TEXT: Record<NonNullable<ToolCallResult["failure"]>, string> = {
  denied: "Freigabe verweigert",
  not_connected: "Server nicht verbunden",
  timeout: "Zeitlimit überschritten",
  aborted: "abgebrochen",
  error: "Fehler auf dem Weg zum Server",
};

/**
 * Ergebnis eines MCP-Aufrufs: bestanden nur, wenn der Server geantwortet hat.
 * Ein Werkzeugfehler oder eine JSON-RPC-Fehlerantwort des Servers (etwa
 * -32602 wegen leerer Argumente) belegt den Aufruf ebenfalls.
 */
export function mcpCallVerdict(result: ToolCallResult): Verdict {
  if (result.failure) return { outcome: "fehler", detail: `${FAILURE_TEXT[result.failure]}: ${result.content}` };
  return { outcome: "ok", detail: `${result.isError ? "Server meldet Werkzeugfehler (leere Argumente?)" : "Antwort"}: ${result.content}` };
}

/** Erster Eintrag server/werkzeug, dessen Werkzeug genau dieser Server anbietet */
export function pickMcpProbeTool(entries: string[], serverOf: (name: string) => string | undefined): { server: string; tool: string } | undefined {
  for (const entry of entries) {
    const slash = entry.indexOf("/");
    const server = entry.slice(0, slash);
    const tool = entry.slice(slash + 1);
    if (slash > 0 && tool && serverOf(tool) === server) return { server, tool };
  }
  return undefined;
}

/** Ruft das MCP-Werkzeug aus MCP_READ_ONLY_TOOLS über den Manager auf */
export async function probeMcpTool(
  manager: { serverOf(name: string): string | undefined; callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> },
  entries: string[]
): Promise<Verdict & { name: string }> {
  const pick = pickMcpProbeTool(entries, (name) => manager.serverOf(name));
  if (!pick) return { name: "MCP-Werkzeug über den Manager", outcome: "übersprungen", detail: "kein verbundenes Werkzeug in MCP_READ_ONLY_TOOLS (server/werkzeug)" };
  // Leere Argumente: auch ein Werkzeugfehler des Servers zeigt, dass der Weg steht
  const verdict = mcpCallVerdict(await manager.callTool(pick.tool, {}));
  return { name: `MCP-Werkzeug ${pick.server}/${pick.tool} über den Manager`, ...verdict };
}

/**
 * Werkzeuge, die --fallback dem Modell anbieten darf: nur lesende Built-ins,
 * in dieser Reihenfolge. Fehlendes requiresApproval heißt nicht lesend
 * (apify_run_actor, telegram_send_document), daher eine feste Liste.
 */
export const PROBE_READ_TOOLS = ["history_search", "firecrawl_search", "firecrawl_scrape", "firecrawl_map", "cloudflare_deployments"] as const;

export function pickProbeTool(offered: string[]): string | undefined {
  return PROBE_READ_TOOLS.find((name) => offered.includes(name));
}

type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;

/** Ein Aufruf des Modells; ohne result wurde er abgelehnt */
export interface ProbeCall {
  name: string;
  result?: ToolCallResult;
}

/** Lässt nur das angebotene Werkzeug durch, alle anderen Namen werden abgelehnt und gemerkt */
export function guardCallTool(allowed: string, call: CallTool, calls: ProbeCall[]): CallTool {
  return async (name, args) => {
    if (name !== allowed) {
      calls.push({ name });
      return { content: JSON.stringify({ error: `Werkzeug ${name} ist in der Probe nicht erlaubt` }), isError: true };
    }
    const result = await call(name, args);
    calls.push({ name, result });
    return result;
  };
}

/** Bestanden nur mit erfolgreichem Aufruf, Antwort und ohne abgelehnte Namen */
export function fallbackCallVerdict(calls: ProbeCall[], text: string): Verdict {
  const list = calls.map((c) => `${c.name} → ${!c.result ? "abgelehnt" : c.result.isError ? "Fehler" : "ok"}`).join(", ") || "keine";
  const refused = calls.some((c) => !c.result);
  const succeeded = calls.some((c) => c.result && !c.result.isError);
  const outcome = !refused && succeeded && text ? "ok" : "fehler";
  return { outcome, detail: `Aufrufe: ${list}; Antwort: ${text || "(keine)"}` };
}

/**
 * Lässt das Modell ein lesendes Werkzeug aufrufen. run bekommt das eine
 * angebotene Werkzeug und den abgesicherten callTool.
 */
export async function probeFallbackTool(
  offered: OpenAITool[],
  callTool: CallTool,
  run: (tool: OpenAITool, callTool: CallTool) => Promise<string>
): Promise<Verdict> {
  const name = pickProbeTool(offered.map((t) => t.function.name));
  const tool = offered.find((t) => t.function.name === name);
  if (!name || !tool) return { outcome: "fehler", detail: `kein lesendes Werkzeug verfügbar (${PROBE_READ_TOOLS.join(", ")})` };
  const calls: ProbeCall[] = [];
  try {
    return fallbackCallVerdict(calls, await run(tool, guardCallTool(name, callTool, calls)));
  } catch (err) {
    return { outcome: "fehler", detail: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const { options, unknown } = parseProbeArgs(argv);
  if (unknown.length > 0) {
    console.error(`Unbekannte Option: ${unknown.join(" ")}. Möglich: ${PROBE_OPTIONS.join(" ")}`);
    return 2;
  }

  const { loadEnv } = await import("../src/lib/env");
  await loadEnv();
  const { mcpManager } = await import("../src/lib/mcp/manager");
  const tools = await import("../src/lib/tools");

  const results: { name: string; outcome: Outcome }[] = [];
  const note = (name: string, outcome: Outcome, detail = "") => {
    results.push({ name, outcome });
    const mark = outcome === "ok" ? "✅" : outcome === "fehler" ? "❌" : "⏭️ ";
    console.log(`  ${mark} ${name}${detail ? `: ${detail}` : ""}`);
  };
  const short = (text: string, n = 160) => text.replace(/\s+/g, " ").slice(0, n);

  try {
    console.log("=== 1. Built-in-Werkzeuge ===");
    for (const t of tools.getAllBuiltinTools()) {
      console.log(`  ${t.name}: ${t.isAvailable() ? "verfügbar" : "Schlüssel fehlt"}${t.requiresApproval ? " [mit Freigabe]" : ""}`);
    }
    const available = tools.getAvailableBuiltinTools();
    note("Built-ins verfügbar", available.length > 0 ? "ok" : "fehler", `${available.length}`);

    console.log("\n=== 2. MCP-Server ===");
    const started = Date.now();
    await mcpManager.init();
    console.log(`  Stand: ${mcpManager.getStatus()} (${Date.now() - started} ms)`);
    const openai = mcpManager.getOpenAITools();
    const anthropic = mcpManager.getAnthropicTools();
    note("Formate gleich lang", openai.length === anthropic.length ? "ok" : "fehler", `OpenAI ${openai.length}, Anthropic ${anthropic.length}`);
    const names = openai.map((t) => t.function.name);
    const doubled = names.filter((n, i) => names.indexOf(n) !== i);
    note("keine doppelten Namen", doubled.length === 0 ? "ok" : "fehler", doubled.join(", "));

    console.log("\n=== 3. Werkzeugaufrufe ===");
    const scrape = tools.getBuiltinTool("firecrawl_scrape");
    if (scrape?.isAvailable()) {
      try {
        const text = await scrape.handler({ url: "https://example.com" });
        note("firecrawl_scrape direkt", text.toLowerCase().includes("example domain") ? "ok" : "fehler", short(text));
      } catch (err) {
        note("firecrawl_scrape direkt", "fehler", err instanceof Error ? err.message : String(err));
      }
    } else note("firecrawl_scrape direkt", "übersprungen", "kein FIRECRAWL_API_KEY");

    if (tools.getBuiltinTool("cloudflare_deployments")?.isAvailable()) {
      const r = await mcpManager.callTool("cloudflare_deployments", {});
      note("cloudflare_deployments über den Manager", r.isError ? "fehler" : "ok", short(r.content));
    } else note("cloudflare_deployments über den Manager", "übersprungen", "kein CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID");

    const readOnly = (process.env.MCP_READ_ONLY_TOOLS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const mcp = await probeMcpTool(mcpManager, readOnly);
    note(mcp.name, mcp.outcome, short(mcp.detail));

    if (options.has("apify")) {
      const r = await mcpManager.callTool("apify_run_actor", {
        actor: "apify/website-content-crawler",
        input: { startUrls: [{ url: "https://example.com" }], maxCrawlPages: 1 },
        maxWaitSeconds: 180,
        maxItems: 1,
      });
      note("apify_run_actor", r.isError ? "fehler" : "ok", short(r.content, 300));
    }
    if (options.has("send")) {
      const file = `/tmp/${BRAND.cli}-probe-${Date.now()}.txt`;
      await Bun.write(file, `${BRAND.name} Werkzeugprobe ${new Date().toISOString()}\n`);
      const r = await mcpManager.callTool("telegram_send_document", { file_path: file, caption: "Werkzeugprobe: telegram_send_document" });
      note("telegram_send_document", r.isError ? "fehler" : "ok", short(r.content));
    }

    console.log("\n=== 4. Telegram-Formatierung ===");
    for (const sample of FORMAT_SAMPLES) {
      const problems = formatProblems(sample);
      note(`lokal: ${sample.name}`, problems.length === 0 ? "ok" : "fehler", problems.length ? problems.join("; ") : `${renderTelegram(sample.markdown).length} Stück(e)`);
    }
    if (options.has("telegram")) {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chat = process.env.TELEGRAM_USER_ID;
      if (!token || !chat) note("Versand an Telegram", "fehler", "TELEGRAM_BOT_TOKEN oder TELEGRAM_USER_ID fehlt");
      else {
        const { sendTelegramMessage } = await import("../src/channels/telegram/send");
        for (const sample of FORMAT_SAMPLES) {
          const sent = await sendTelegramMessage(token, chat, `**Probe: ${sample.name}**\n\n${sample.markdown}`, { parseMode: "HTML" });
          note(`gesendet: ${sample.name}`, sent ? "ok" : "fehler");
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }

    if (options.has("fallback")) {
      console.log("\n=== 5. Ersatzmodell mit Werkzeugen ===");
      await probeFallback(mcpManager, note, short);
    }
  } catch (err) {
    note("Probe", "fehler", err instanceof Error ? err.message : String(err));
  } finally {
    await mcpManager.shutdown();
  }

  const failed = results.filter((r) => r.outcome === "fehler").length;
  const skipped = results.filter((r) => r.outcome === "übersprungen").length;
  console.log(`\n${failed === 0 ? "✅" : "❌"} ${results.length - failed - skipped} bestanden, ${failed} fehlgeschlagen, ${skipped} übersprungen`);
  return probeExitCode(results.map((r) => r.outcome));
}

/** Echtes Ersatzmodell muss ein lesendes Werkzeug wirklich aufrufen */
async function probeFallback(
  manager: typeof import("../src/lib/mcp/manager").mcpManager,
  note: (name: string, outcome: Outcome, detail?: string) => void,
  short: (text: string, n?: number) => string
): Promise<void> {
  const chain = await import("../src/lib/fallback/chain");
  const loop = await import("../src/lib/fallback/openai-tool-loop");

  const key = process.env.OPENROUTER_API_KEY || "";
  const online = !!key && !chain.FALLBACK_OFFLINE_ONLY();
  const model = online ? chain.OPENROUTER_MODEL() : chain.OLLAMA_MODEL();
  const verdict = await probeFallbackTool(manager.getOpenAITools(), (name, args) => manager.callTool(name, args), (tool, callTool) =>
    loop.runToolLoop({
      url: online ? chain.OPENROUTER_URL : chain.OLLAMA_URL,
      apiKey: online ? key : "",
      headers: online ? { ...OPENROUTER_APP_HEADERS } : undefined,
      model,
      system: "Du bist eine Werkzeugprobe. Nutze das angebotene Werkzeug genau einmal, dann antworte in einem Satz auf Deutsch.",
      question: `Rufe jetzt das Werkzeug ${tool.function.name} auf (Argumente passend zum Schema, als Suchbegriff "test"), dann sag in einem Satz, was zurückkam.`,
      tools: [tool],
      timeoutMs: 120_000,
      maxTokens: 800,
      maxRounds: 3,
    }, { ...loop.realToolLoopDeps, callTool }).then((text) => text ?? "")
  );
  note("Werkzeugaufruf durch das Modell", verdict.outcome, `${online ? "OpenRouter" : "Ollama"} ${model}, ${short(verdict.detail, 300)}`);

  const answer = await chain.runFallbackChain({
    question: "Wie heiße ich? Antworte mit einem Wort.",
    context: "## USER PROFILE\nDer Nutzer heißt Alex und mag kurze Antworten.",
  }).catch((err: unknown) => ({ text: err instanceof Error ? err.message : String(err), source: "none" as const }));
  const knows = answer.source !== "none" && /alex/i.test(answer.text);
  note("Kette mit Gesprächskontext", knows ? "ok" : "fehler", `${answer.source}${"model" in answer && answer.model ? ` (${answer.model})` : ""}: ${short(answer.text)}`);
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
