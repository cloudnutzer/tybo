/**
 * Hilfen für die Tests des Einrichtungsmodus (Issue #66): Server im
 * temporären Projekt aus setup-fixture.ts, Port 0, Supervisor-Attrappe.
 * Nichts startet launchctl, PM2, Claude oder den Bot; nichts geht ins Netz.
 */

import { connect } from "node:net";
import type { SetupContext } from "../src/setup/context";
import type { SetupStep } from "../src/setup/model";
import type { Supervisor } from "../src/lib/restart-request";
import { LoginLimiter } from "../src/web/auth";
import { createSetupServer, type SetupServer } from "../src/setup/web-server";
import { FULL_ENV, makeCtx, type FakeProviders, type FakeRun } from "./setup-fixture";

export const CODE = "K7MP2QXR";

export const PROFILE = "# Testperson\n\n## Über mich\n- Zeitzone: Europe/Berlin\n";

export type TestCtx = SetupContext & { providers: FakeProviders; run: FakeRun };

export interface Started {
  server: SetupServer;
  ctx: TestCtx;
  base: string;
  origin: string;
  logs: string[];
  supervisor: { value: Supervisor | null };
}

export async function startSetup(
  options: {
    env?: string;
    profile?: string;
    ctx?: TestCtx;
    limiter?: LoginLimiter;
    now?: () => number;
    /** Statt der Attrappe mit supervisor.value, etwa um „Fertig“ anzuhalten */
    supervisorFn?: () => Promise<Supervisor | null>;
    /** Eigener Schrittkatalog (Issue #161, Test-Schritt) */
    steps?: readonly SetupStep[];
  } = {},
): Promise<Started> {
  const ctx = options.ctx ?? (await makeCtx({ env: options.env, profile: options.profile }));
  const logs: string[] = [];
  const supervisor = { value: null as Supervisor | null };
  const server = await createSetupServer({
    ctx,
    code: CODE,
    port: 0,
    supervisor: options.supervisorFn ?? (async () => supervisor.value),
    startCommand: `cd ${ctx.root} && bun run start`,
    log: line => logs.push(line),
    limiter: options.limiter,
    now: options.now,
    steps: options.steps,
  });
  return { server, ctx, base: server.url, origin: server.url, logs, supervisor };
}

/** Fertige Einrichtung: alle Pflichtschritte außer Autostart erledigt */
export function readyOptions() {
  return { env: FULL_ENV, profile: PROFILE };
}

export async function post(s: Started, path: string, body: unknown, cookie = ""): Promise<Response> {
  return fetch(`${s.base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: s.origin, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

export async function get(s: Started, path: string, cookie = ""): Promise<Response> {
  return fetch(`${s.base}${path}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" });
}

/** Mit dem Einmal-Code anmelden; gibt das Cookie „name=wert“ zurück */
export async function login(s: Started, code = CODE): Promise<string> {
  const res = await post(s, "/api/setup/code", { code });
  if (res.status !== 200) throw new Error(`Anmeldung: ${res.status}`);
  return res.headers.get("set-cookie")!.split(";")[0];
}

/** Rohe Anfrage mit beliebigem Host-Header (fetch setzt ihn selbst) */
export function rawRequest(base: string, path: string, host: string): Promise<string> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    const done = () => {
      socket.destroy();
      resolve(data);
    };
    socket.on("data", d => {
      data += d.toString();
      const end = data.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/content-length: *(\d+)/i.exec(data.slice(0, end))?.[1] ?? 0);
      if (Buffer.byteLength(data.slice(end + 4)) >= length) done();
    });
    socket.on("end", done);
    socket.on("error", reject);
  });
}
