/**
 * Schritt „google“ (Issue #356): Zugang zu Kalender und Gmail für Briefing
 * und Board. Abgefragt werden Client-ID und Client-Secret eines
 * Desktop-Clients; den Refresh-Token holt der Ablauf über die Anmeldung im
 * Browser (src/setup/google-oauth.ts). Gespeichert werden alle drei
 * GOOGLE_*-Werte zusammen in einem Schreibvorgang, erst wenn der Tausch
 * geklappt hat; sonst bleibt die .env, wie sie war.
 *
 * status() schaut nur, ob die Werte da sind. test() (Gesamtprüfung) erneuert
 * das Zugriffstoken und liest einmal Kalender und Gmail, öffnet aber nie eine
 * neue Anmeldung.
 */

import { BRAND } from "../../brand";
import { googleAccessToken } from "../../lib/google/token";
import type { HttpFetch, SetupContext } from "../context";
import {
  CALLBACK_PORT,
  exchangeCode,
  probeGoogleApis,
  serveLoopback,
  SIGN_IN_TIMEOUT_MS,
  sshHint,
  waitForSignIn,
  type GoogleOAuthDeps,
} from "../google-oauth";
import { fieldStates, mergeValues, stateFromCount, type ApplyResult, type SetupField, type SetupStep, type StatusItem } from "../model";
import { envValues, invalid, writeEnv } from "./common";

export const GOOGLE_CONSOLE = "https://console.cloud.google.com/apis/credentials";
const CLIENT_ID_SUFFIX = ".apps.googleusercontent.com";

export const GOOGLE_FIELDS: SetupField[] = [
  {
    name: "GOOGLE_CLIENT_ID",
    label: "Google Client-ID",
    kind: "text",
    required: true,
    help: `In der Google Cloud Console ein Projekt anlegen, „Google Calendar API“ und „Gmail API“ aktivieren, dann unter APIs und Dienste, Anmeldedaten eine OAuth-Client-ID vom Typ „Desktop-App“ erstellen. Die Client-ID endet auf ${CLIENT_ID_SUFFIX}.`,
    link: GOOGLE_CONSOLE,
    validate: v => (v.endsWith(CLIENT_ID_SUFFIX) && !/\s/.test(v) ? null : `Client-ID endet auf ${CLIENT_ID_SUFFIX}`),
  },
  {
    name: "GOOGLE_CLIENT_SECRET",
    label: "Google Client-Secret",
    kind: "secret",
    required: true,
    help: "Steht beim selben Desktop-Client unter dem Client-Secret.",
    link: GOOGLE_CONSOLE,
    validate: v => (/\s/.test(v) ? "Client-Secret enthält keine Leerzeichen" : null),
  },
];

const FIELD_NAMES = GOOGLE_FIELDS.map(f => f.name);
const ALL_NAMES = [...FIELD_NAMES, "GOOGLE_REFRESH_TOKEN"];
const TOTAL = 5;

/** Echte Abhängigkeiten, ersetzbar über ctx.googleOAuth */
function depsFor(ctx: SetupContext): GoogleOAuthDeps {
  const opener = ctx.platform === "darwin" ? "open" : ctx.platform === "linux" ? "xdg-open" : null;
  return {
    serve: serveLoopback,
    openBrowser: async url => (opener ? (await ctx.run([opener, url], { timeoutMs: 10_000 })).code === 0 : false),
    port: CALLBACK_PORT,
    timeoutMs: SIGN_IN_TIMEOUT_MS,
    ...ctx.googleOAuth,
  };
}

/** ctx.fetch in der Form, die googleAccessToken erwartet */
function asFetch(fetchFn: HttpFetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    fetchFn(String(input), {
      method: init?.method,
      headers: init?.headers as Record<string, string> | undefined,
      body: init?.body === undefined || init?.body === null ? undefined : String(init.body),
      signal: init?.signal ?? undefined,
    })) as typeof fetch;
}

function summary(items: StatusItem[]): string {
  const failed = items.filter(i => !i.ok);
  if (!failed.length) return "Kalender und Gmail sind lesbar.";
  return `Nicht lesbar: ${failed.map(i => `${i.label} (${i.detail}${i.fix ? ` ${i.fix}` : ""})`).join(", ")}`;
}

export const googleStep: SetupStep = {
  id: "google",
  title: "Google-Kalender und Gmail",
  description: `Optional: Termine von heute und ungelesene Mails im Morgen-Briefing von ${BRAND.name}, nur lesend. Braucht ein eigenes Projekt in der Google Cloud Console.`,
  optional: true,
  fields: GOOGLE_FIELDS,

  async status(ctx) {
    const existing = await envValues(ctx, ALL_NAMES);
    const done = ALL_NAMES.filter(n => existing[n]).length;
    const state = stateFromCount(done, ALL_NAMES.length);
    const detail =
      state === "erledigt"
        ? "Client-ID, Client-Secret und Refresh-Token sind gesetzt."
        : state === "teilweise"
          ? `Unvollständig, es fehlt: ${ALL_NAMES.filter(n => !existing[n]).join(", ")}.`
          : "Noch kein Google-Zugang eingerichtet.";
    return { state, detail, fields: fieldStates(GOOGLE_FIELDS, existing) };
  },

  /** Nur mit gespeichertem Refresh-Token; öffnet nie eine neue Anmeldung */
  async test(values, ctx, signal) {
    const existing = await envValues(ctx, ALL_NAMES);
    const problem = invalid(GOOGLE_FIELDS, values, existing);
    if (problem) return problem;
    const merged = mergeValues(existing, values);
    if (!merged.GOOGLE_REFRESH_TOKEN) {
      return { ok: false, message: `Noch keine Anmeldung bei Google. Mit ${BRAND.cli} setup google einrichten.` };
    }
    let token: string;
    try {
      token = await googleAccessToken({ env: merged, fetch: asFetch(ctx.fetch), signal });
    } catch (e) {
      const message = e instanceof Error && e.name !== "AbortError" ? e.message : "Abgebrochen.";
      return { ok: false, message, items: [{ label: "Zugang", ok: false, detail: message }] };
    }
    const items = await probeGoogleApis(ctx.fetch, token, signal);
    return { ok: items.every(i => i.ok), message: summary(items), items };
  },

  plan() {
    return [
      "Startet auf diesem Rechner eine Anmeldeseite, nur über 127.0.0.1 erreichbar.",
      "Öffnet den Browser für die Anmeldung bei Google (nur Lesen von Kalender und Gmail).",
      "Tauscht die Antwort von Google gegen einen Refresh-Token.",
      "Speichert Client-ID, Client-Secret und Refresh-Token zusammen in der .env.",
      "Liest zur Probe einmal Kalender und Gmail.",
    ];
  },

  async run(values, ctx, report, signal): Promise<ApplyResult> {
    const existing = await envValues(ctx, ALL_NAMES);
    const problem = invalid(GOOGLE_FIELDS, values, existing);
    if (problem) return { ok: false, message: problem.message, changed: [] };
    const merged = mergeValues(existing, values);
    const deps = depsFor(ctx);
    const kept = "Die .env ist unverändert.";

    report({ at: 1, total: TOTAL, label: "Starte die Anmeldeseite auf diesem Rechner" });
    let opened: Promise<boolean> = Promise.resolve(false);
    const signIn = await waitForSignIn({
      clientId: merged.GOOGLE_CLIENT_ID,
      deps,
      signal,
      onReady: start => {
        report({
          at: 2,
          total: TOTAL,
          label: "Warte auf die Anmeldung bei Google im Browser",
          detail: `Geht kein Fenster auf, ${start} öffnen. Läuft die Einrichtung per SSH, vorher ${sshHint(deps.port)}`,
        });
        opened = deps.openBrowser(start).catch(() => false);
      },
    });
    await opened;
    if (!signIn.ok) return { ok: false, message: `${signIn.message} ${kept}`, changed: [] };

    report({ at: 3, total: TOTAL, label: "Hole den Zugang bei Google ab" });
    const exchanged = await exchangeCode(
      ctx.fetch,
      {
        clientId: merged.GOOGLE_CLIENT_ID,
        clientSecret: merged.GOOGLE_CLIENT_SECRET,
        code: signIn.code,
        verifier: signIn.verifier,
        redirectUri: signIn.redirectUri,
      },
      signal,
    );
    if (!exchanged.ok) return { ok: false, message: `${exchanged.message} ${kept}`, changed: [] };
    if (signal.aborted) return { ok: false, message: `Abgebrochen. ${kept}`, changed: [] };

    report({ at: 4, total: TOTAL, label: "Speichere den Google-Zugang" });
    const written = await writeEnv(ctx, [
      ["GOOGLE_CLIENT_ID", merged.GOOGLE_CLIENT_ID],
      ["GOOGLE_CLIENT_SECRET", merged.GOOGLE_CLIENT_SECRET],
      ["GOOGLE_REFRESH_TOKEN", exchanged.refreshToken],
    ]);
    if (!written.ok) return written;

    report({ at: 5, total: TOTAL, label: "Lese zur Probe Kalender und Gmail" });
    const items = await probeGoogleApis(ctx.fetch, exchanged.accessToken, signal);
    const ok = items.every(i => i.ok);
    return {
      ok,
      message: ok
        ? `Google-Zugang gespeichert. ${summary(items)} Das nächste Morgen-Briefing zeigt sie.`
        : `Google-Zugang gespeichert. ${summary(items)}`,
      changed: written.changed,
    };
  },
};
