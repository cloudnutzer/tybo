/**
 * Issue #511: /anruf über eine Nummer am SIP-Trunk (eigene Vermittlung).
 * ELEVENLABS_PHONE_PROVIDER wählt den Aufruf; ohne Wert bleibt alles wie
 * mit Twilio. Anfrage und Antwort mit fetch-Attrappe.
 */
import { describe, expect, test } from "bun:test";
import { createElevenLabsCaller, ELEVENLABS_API, phoneConfigured, phoneProviderKind } from "../src/lib/phone/provider";

const ENV = {
  ELEVENLABS_API_KEY: "test-key",
  ELEVENLABS_AGENT_ID: "agent-1",
  ELEVENLABS_PHONE_NUMBER_ID: "number-1",
  USER_PHONE_NUMBER: "+49 151 0000000",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeFetch(reply: Response) {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    return reply.clone();
  };
  return { fetch, calls };
}

describe("Art der Nummer", () => {
  test("ohne Wert und mit twilio: Twilio; sip_trunk: SIP; sonst ungültig", () => {
    expect(phoneProviderKind({})).toBe("twilio");
    expect(phoneProviderKind({ ELEVENLABS_PHONE_PROVIDER: " Twilio " })).toBe("twilio");
    expect(phoneProviderKind({ ELEVENLABS_PHONE_PROVIDER: "sip_trunk" })).toBe("sip_trunk");
    expect(phoneProviderKind({ ELEVENLABS_PHONE_PROVIDER: "sip" })).toBeNull();
  });

  test("ungültige Art: gilt als nicht eingerichtet, es wird nicht gewählt", async () => {
    const net = fakeFetch(json({ success: true, message: "ok", conversation_id: "c1" }));
    const env = { ...ENV, ELEVENLABS_PHONE_PROVIDER: "easybell" };
    const caller = createElevenLabsCaller({ env, fetch: net.fetch });
    expect(caller.missing()).toEqual(["ELEVENLABS_PHONE_PROVIDER"]);
    expect(phoneConfigured(env)).toBe(false);
    const result = await caller.dial({ ref: "r1", greeting: "Hallo", variables: {} });
    expect(result).toEqual({ ok: false, error: "nicht eingerichtet (ELEVENLABS_PHONE_PROVIDER)" });
    expect(net.calls).toHaveLength(0);
  });
});

describe("Anwahl über den SIP-Trunk", () => {
  test("Anfrage an /sip-trunk/outbound-call mit Agent, Nummer, erstem Satz und Kennung, ohne Twilio-Felder", async () => {
    const net = fakeFetch(json({ success: true, message: "ok", conversation_id: "conv-9", sip_call_id: "sip-1" }));
    const caller = createElevenLabsCaller({ env: { ...ENV, ELEVENLABS_PHONE_PROVIDER: "sip_trunk" }, fetch: net.fetch });
    const result = await caller.dial({ ref: "r7", greeting: "Hallo Alex", variables: { call_reason: "Folien" } });
    expect(result).toEqual({ ok: true, conversationId: "conv-9" });
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].url).toBe(`${ELEVENLABS_API}/sip-trunk/outbound-call`);
    expect(net.calls[0].headers["xi-api-key"]).toBe("test-key");
    expect(net.calls[0].body).toEqual({
      agent_id: "agent-1",
      agent_phone_number_id: "number-1",
      to_number: "+49 151 0000000",
      conversation_initiation_client_data: {
        dynamic_variables: { call_reason: "Folien", tybo_call_ref: "r7" },
        conversation_config_override: { agent: { first_message: "Hallo Alex" } },
      },
    });
  });

  test("Antwort ohne Erfolg oder mit Fehlerstatus: kein Anruf, Fehlertext", async () => {
    const declined = fakeFetch(json({ success: false, message: "Trunk nicht erreichbar", conversation_id: null, sip_call_id: null }));
    const env = { ...ENV, ELEVENLABS_PHONE_PROVIDER: "sip_trunk" };
    expect(await createElevenLabsCaller({ env, fetch: declined.fetch }).dial({ ref: "r1", greeting: "Hallo", variables: {} })).toEqual({
      ok: false,
      error: "Trunk nicht erreichbar",
    });
    const invalid = fakeFetch(json({ detail: [{ loc: ["body", "to_number"], msg: "invalid", type: "value_error" }] }, 422));
    const result = await createElevenLabsCaller({ env, fetch: invalid.fetch }).dial({ ref: "r1", greeting: "Hallo", variables: {} });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("HTTP 422");
  });

  test("Erfolg ohne conversation_id: Anruf läuft, Protokoll ist nicht abrufbar", async () => {
    const net = fakeFetch(json({ success: true, message: "ok", conversation_id: null, sip_call_id: "sip-1" }));
    const result = await createElevenLabsCaller({ env: { ...ENV, ELEVENLABS_PHONE_PROVIDER: "sip_trunk" }, fetch: net.fetch }).dial({ ref: "r1", greeting: "Hallo", variables: {} });
    expect(result).toEqual({ ok: true, conversationId: null });
  });

  test("ohne ELEVENLABS_PHONE_PROVIDER bleibt der Twilio-Aufruf unverändert", async () => {
    const net = fakeFetch(json({ success: true, message: "ok", conversation_id: "conv-1" }));
    await createElevenLabsCaller({ env: ENV, fetch: net.fetch }).dial({ ref: "r1", greeting: "Hallo", variables: {} });
    expect(net.calls[0].url).toBe(`${ELEVENLABS_API}/twilio/outbound-call`);
    expect(net.calls[0].body.max_duration_seconds).toBe(300);
    expect(net.calls[0].body.first_message).toBe("Hallo");
  });
});
