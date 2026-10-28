/**
 * Apify Built-in — Actor starten und Dataset-Items zurueckgeben.
 *
 * REST: POST /v2/acts/{actor}/runs (waitForFinish nutzt die API-seitige
 * Wartezeit, danach Polling bis maxWaitSeconds), dann Dataset-Items
 * lesen. Kein Abbruch des Runs bei Timeout — stattdessen Run-ID melden,
 * damit das Modell den Status kommunizieren kann.
 */

import { optionalCredential } from "../credentials";
import { registerBuiltinTool } from "./registry";

const API = "https://api.apify.com/v2";

function token(): string {
  return optionalCredential("APIFY_API_KEY");
}

async function apifyGet(path: string): Promise<any> {
  const res = await fetch(`${API}${path}${path.includes("?") ? "&" : "?"}token=${token()}`, {
    signal: AbortSignal.timeout(70_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Apify HTTP ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

registerBuiltinTool({
  name: "apify_run_actor",
  description:
    "Run an Apify actor (web scraper from the Apify store, e.g. 'apify/google-search-scraper') with a JSON input and return its dataset items. Costs Apify credits — use only when the user asks for data a specific actor provides (LinkedIn profiles, Google results at scale, etc.).",
  inputSchema: {
    type: "object",
    properties: {
      actor: {
        type: "string",
        description:
          "Actor ID, e.g. 'apify/google-search-scraper' or 'username~actor-name'",
      },
      input: {
        type: "object",
        description: "Actor input object (actor-specific schema)",
      },
      maxWaitSeconds: {
        type: "number",
        description: "How long to wait for the run to finish (default 120, max 280)",
      },
      maxItems: {
        type: "number",
        description: "Max dataset items to return (default 20)",
      },
    },
    required: ["actor"],
  },
  isAvailable: () => !!token(),
  handler: async (args) => {
    const actorId = String(args.actor).replace("/", "~");
    const maxWait = Math.min(Number(args.maxWaitSeconds) || 120, 280);
    const maxItems = Math.min(Number(args.maxItems) || 20, 100);

    // Run starten; die API wartet serverseitig bis zu 60s auf das Ende
    const startRes = await fetch(
      `${API}/acts/${encodeURIComponent(actorId)}/runs?token=${token()}&waitForFinish=${Math.min(maxWait, 60)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args.input || {}),
        signal: AbortSignal.timeout(70_000),
      }
    );
    if (!startRes.ok) {
      const text = await startRes.text().catch(() => "");
      throw new Error(
        `Apify run start HTTP ${startRes.status}: ${text.substring(0, 200)}`
      );
    }
    let run = ((await startRes.json()) as any).data;

    // Polling bis fertig oder maxWait erreicht
    const deadline = Date.now() + maxWait * 1000;
    while (
      run.status === "RUNNING" ||
      run.status === "READY"
    ) {
      if (Date.now() > deadline) {
        return JSON.stringify({
          status: run.status,
          runId: run.id,
          message: `Actor laeuft noch nach ${maxWait}s. Ergebnis spaeter unter https://console.apify.com/actors/runs/${run.id}`,
        });
      }
      await new Promise((r) => setTimeout(r, 5000));
      run = (await apifyGet(`/actor-runs/${run.id}`)).data;
    }

    if (run.status !== "SUCCEEDED") {
      return JSON.stringify({
        status: run.status,
        runId: run.id,
        error: `Actor-Run endete mit Status ${run.status}`,
      });
    }

    const items = await apifyGet(
      `/datasets/${run.defaultDatasetId}/items?format=json&clean=true&limit=${maxItems}`
    );
    return JSON.stringify({
      status: "SUCCEEDED",
      runId: run.id,
      itemCount: Array.isArray(items) ? items.length : 0,
      items,
    });
  },
});
