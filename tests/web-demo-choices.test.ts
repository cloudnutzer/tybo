// Demo mit Rückfrage-Knöpfen (Issue #115): im Topic „Strategie" eine
// erledigte und eine offene Werkzeug-Freigabe aus einem Register nur im
// Speicher; Klick im Browser und simulierter Klick in Telegram wirken dort.
import { expect, test } from "bun:test";
import { DEMO_CHOICES, startDemoServer } from "../src/web/demo";

const config = { host: "127.0.0.1", port: 0, password: "demo-passwort-lang", allowedHosts: [] };

test("Demo: erledigte und offene Rückfrage im Topic Strategie, Klick entscheidet einmal", async () => {
  const demo = await startDemoServer(config, { log: () => {} });
  const origin = demo.server.url;
  const choiceOf = async (id: string) => {
    const history = await (await fetch(`${origin}/api/conversations/topic-31/messages`)).json();
    return history.messages.find((m: any) => m.choice?.id === id)?.choice;
  };
  try {
    expect(await choiceOf(DEMO_CHOICES.done)).toMatchObject({ state: "done", options: [], result: { label: "Erlauben", via: "telegram" } });
    expect(await choiceOf(DEMO_CHOICES.open)).toMatchObject({ state: "open", options: [{ label: "Erlauben" }, { label: "Ablehnen" }] });
    const post = (option: string) =>
      fetch(`${origin}/api/conversations/topic-31/choices/${DEMO_CHOICES.open}`, { method: "POST", headers: { origin }, body: JSON.stringify({ option }) });
    expect((await post("vielleicht")).status).toBe(400);
    expect((await post("no")).status).toBe(200);
    expect((await post("ok")).status).toBe(409);
    expect(await choiceOf(DEMO_CHOICES.open)).toMatchObject({ state: "done", result: { label: "Ablehnen", via: "web" } });
    expect((await demo.choices.decideInTelegram(DEMO_CHOICES.open, "ok")).status).toBe("already");
    // Andere Gespräche kennen die Fragen nicht
    const other = await fetch(`${origin}/api/conversations/topic-443/choices/${DEMO_CHOICES.done}`, { method: "POST", headers: { origin }, body: JSON.stringify({ option: "ok" }) });
    expect(other.status).toBe(404);
  } finally {
    await demo.stop();
  }
});
