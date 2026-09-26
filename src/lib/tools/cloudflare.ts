/**
 * Cloudflare Built-in — read-only Deployment-Status via REST-API.
 *
 * Bewusst KEIN schreibendes Deploy (PRD-Entscheidung: schreibende Tools
 * erst nach HITL-Gate, Phase 3). Dieses Tool listet Pages-Projekte und
 * ihre letzten Deployments — genug, um "ist mein Deploy live?" zu
 * beantworten. Token muss account-scoped sein (cfat_, siehe Memory
 * reference_cloudflare_access).
 */

import { optionalCredential } from "../credentials";
import { registerBuiltinTool } from "./registry";

const API = "https://api.cloudflare.com/client/v4";

function token(): string {
  return optionalCredential("CLOUDFLARE_API_TOKEN");
}

function accountId(): string {
  return optionalCredential("CLOUDFLARE_ACCOUNT_ID");
}

async function cfGet(path: string): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token()}` },
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || data.success === false) {
    const errs = (data.errors || [])
      .map((e: any) => e.message)
      .join("; ");
    throw new Error(`Cloudflare HTTP ${res.status}${errs ? `: ${errs}` : ""}`);
  }
  return data.result;
}

registerBuiltinTool({
  name: "cloudflare_deployments",
  description:
    "Read-only: list Cloudflare Pages projects and their latest deployment status/URL. Pass a project name to see its recent deployments. Cannot deploy — only reports status.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description:
          "Pages project name. Omit to list all projects with their latest deployment.",
      },
      limit: {
        type: "number",
        description: "Max deployments to return for a project (default 5)",
      },
    },
    required: [],
  },
  isAvailable: () => !!token() && !!accountId(),
  handler: async (args) => {
    if (args.project) {
      const limit = Math.min(Number(args.limit) || 5, 20);
      const deployments = await cfGet(
        `/accounts/${accountId()}/pages/projects/${encodeURIComponent(String(args.project))}/deployments?per_page=${limit}`
      );
      return JSON.stringify(
        (deployments || []).map((d: any) => ({
          id: d.id?.substring(0, 8),
          environment: d.environment,
          url: d.url,
          created_on: d.created_on,
          status: d.latest_stage
            ? `${d.latest_stage.name}: ${d.latest_stage.status}`
            : "unknown",
        }))
      );
    }

    const projects = await cfGet(`/accounts/${accountId()}/pages/projects`);
    return JSON.stringify(
      (projects || []).map((p: any) => ({
        name: p.name,
        subdomain: p.subdomain,
        created_on: p.created_on,
        latest_deployment: p.latest_deployment
          ? {
              url: p.latest_deployment.url,
              created_on: p.latest_deployment.created_on,
              status: p.latest_deployment.latest_stage
                ? `${p.latest_deployment.latest_stage.name}: ${p.latest_deployment.latest_stage.status}`
                : "unknown",
            }
          : null,
      }))
    );
  },
});
