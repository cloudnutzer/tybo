/**
 * Issue #351: ElevenLabs-Webhook mit der echten Verdrahtung des Anrufdienstes
 * (createPhone aus src/lib/phone/index.ts, Zusammenfassung über callAux in
 * src/lib/call-summary.ts). Ersetzt sind nur das Modell unter callAux (CLI-
 * Attrappe), die Zustellung und das Warten zwischen zwei Versuchen. Kein
 * Netz, keine Datenbank, src/bot.ts wird nie importiert.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHmac } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServerRoutes } from "../src/app/server-routes";
import * as claudeModule from "../src/lib/claude";
import { setChoicesFileForTests } from "../src/lib/choices";
import type { SendAndRecordInput } from "../src/lib/outbox";
import { createPhone, createPhoneLedger, phoneLedgerPath, PHONE_TEXT } from "../src/lib/phone";
import { setSettingsPath } from "../src/lib/settings";
import { resetStore } from "../src/lib/store";

const EL_SECRET = "elevenlabs-secret-fuer-tests";
const ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "AUX_MODEL_CALL_SUMMARY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const SUMMARY = "Folien für Freitag besprochen.";

const savedEnv: Record<string, string | undefined> = {};
let spies: { mockRestore(): void }[] = [];
let dir: string;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  resetStore();
  dir = mkdtempSync(join(tmpdir(), "server-routes-wiring-"));
  setSettingsPath(join(dir, "settings.json"));
  setChoicesFileForTests(join(dir, "choices.json"));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const s of spies) s.mockRestore();
  spies = [];
  resetStore();
  setSettingsPath();
  setChoicesFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

function signed(body: string): Request {
  const t = Math.floor(Date.now() / 1000);
  const signature = `t=${t},v0=${createHmac("sha256", EL_SECRET).update(`${t}.${body}`).digest("hex")}`;
  return new Request("http://127.0.0.1:3080/webhook/elevenlabs", {
    method: "POST",
    headers: { "content-type": "application/json", "elevenlabs-signature": signature },
    body,
  });
}

const event = JSON.stringify({
  type: "post_call_transcription",
  data: {
    conversation_id: "conv-fremd",
    status: "done",
    transcript: [
      { role: "agent", message: "Hallo Alex, hier ist Mia." },
      { role: "user", message: "Bitte bereite die Folien für Freitag vor." },
    ],
  },
});

test("Modellfehler: erst 500 und offener Eintrag, nach Erholung verarbeitet und zugestellt", async () => {
  // Modell unter callAux: erst gestört, dann gesund (Zusammenfassung bzw. kein Auftrag)
  let healthy = false;
  const prompts: string[] = [];
  spies.push(
    spyOn(claudeModule, "callClaude").mockImplementation((async (options: { prompt: string }) => {
      prompts.push(String(options.prompt));
      if (!healthy) return { text: "", isError: true };
      return { text: String(options.prompt).includes("short summary") ? SUMMARY : "NONE", isError: false };
    }) as never),
  );
  const sent: SendAndRecordInput[] = [];
  const waiters: (() => void)[] = [];
  const phone = createPhone({
    send: async input => (sent.push(input), { sent: true, recorded: true }) as never,
    sendChoice: async () => ({ sent: true }),
    task: {} as never,
    env: { GO_PROJECT_ROOT: dir, TELEGRAM_BOT_TOKEN: "123:test", TELEGRAM_USER_ID: "4711", USER_NAME: "Alex" },
    log: () => {},
    // Der eigene neue Versuch wartet, bis der Test ihn freigibt
    sleep: () => new Promise<void>(resolve => waiters.push(resolve)),
  });
  const routes = createServerRoutes({ env: { ELEVENLABS_WEBHOOK_SECRET: EL_SECRET }, root: dir, transcripts: () => phone, log: () => {} });
  const ledger = createPhoneLedger(phoneLedgerPath(dir));

  const failed = await routes(signed(event))!;
  expect(failed.status).toBe(500);
  expect(ledger.byConversationId("conv-fremd")).toMatchObject({ stage: "received", inbound: true, transcript: expect.stringContaining("Alex: Bitte bereite") });
  expect(sent).toEqual([]);
  expect(prompts.length).toBeGreaterThan(0);
  // Der eigene neue Versuch des Dienstes scheitert ebenfalls und wartet dann
  for (let i = 0; i < 500 && waiters.length === 0; i++) await Bun.sleep(2);
  expect(waiters).toHaveLength(1);
  expect(ledger.byConversationId("conv-fremd")?.stage).toBe("received");

  healthy = true;
  const retried = await routes(signed(event))!;
  expect(retried.status).toBe(200);
  expect(await retried.json()).toEqual({ ok: true });
  expect(ledger.byConversationId("conv-fremd")?.stage).not.toBe("received");

  for (const resume of waiters.splice(0)) resume();
  await phone.idle();
  phone.stop();
  const summaries = sent.filter(input => input.text === PHONE_TEXT.summary(SUMMARY));
  expect(summaries).toHaveLength(1);
  expect(summaries[0]).toMatchObject({ chatId: "4711" });
  expect(sent.some(input => input.text?.includes("Summarization failed"))).toBe(false);
  expect(ledger.byConversationId("conv-fremd")?.stage).toBe("closed");

  // Spätere Zustellung: schon bearbeitet, nichts doppelt
  const replay = await routes(signed(event))!;
  expect(await replay.json()).toEqual({ ok: true, skipped: "schon bearbeitet" });
  expect(sent.filter(input => input.text === PHONE_TEXT.summary(SUMMARY))).toHaveLength(1);
});
