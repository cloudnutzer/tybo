/**
 * Issue #494: selbst gehostetes SDK des Anbieters für die Gesprächsseite
 * (scripts/vendor-elevenlabs.ts). Prüfsummen wie in VERSION.json, Lizenzen
 * dabei, Worklet passt zur Version, keine fremden Hosts außer denen der CSP der
 * Gesprächsseite, Auslieferung nur nach dem Login.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PUBLIC_ASSETS, type WebServer } from "../src/web/server";
import { DEMO_VOICE_AGENT_SDK } from "../src/web/demo-voice-sdk";
import { VOICE_AGENT_CONNECT_HOSTS, VOICE_AGENT_SDK_PATH } from "../src/web/voice-agent-page";
import { topicServer } from "./topic-fixture";

const DIR = resolve(import.meta.dir, "..", "src", "web", "public", "vendor", "elevenlabs");
const version = JSON.parse(readFileSync(join(DIR, "VERSION.json"), "utf8"));
const lib = readFileSync(join(DIR, "lib.iife.js"), "utf8");
const worklet = readFileSync(join(DIR, "rawAudioProcessor.js"), "utf8");
const pageSource = readFileSync(resolve(DIR, "..", "..", "sprachagent.js"), "utf8");

const root = await mkdtemp(join(tmpdir(), "voice-agent-vendor-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
});

describe("Vendor-Dateien des SDK", () => {
  test("genau die Dateien aus VERSION.json, Prüfsummen stimmen", () => {
    expect(readdirSync(DIR).sort()).toEqual([...Object.keys(version.sha256), "VERSION.json"].sort());
    for (const [name, sum] of Object.entries(version.sha256)) {
      expect(createHash("sha256").update(readFileSync(join(DIR, name))).digest("hex")).toBe(sum as string);
    }
    expect(version.pakete["@elevenlabs/client"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(version.pakete["livekit-client"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("Lizenzen: MIT für den Client, Apache-2.0 für livekit-client", () => {
    expect(readFileSync(join(DIR, "LICENSE-elevenlabs-client.txt"), "utf8")).toContain("MIT License");
    expect(readFileSync(join(DIR, "LICENSE-livekit-client.txt"), "utf8")).toContain("Apache License");
  });

  test("Worklet registriert genau den Prozessor, den diese Fassung des SDK erwartet", () => {
    const name = /registerProcessor\("(rawAudioProcessor@[0-9a-f]+)"/.exec(worklet)?.[1];
    expect(name).toBeDefined();
    const [, hash] = name!.split("@");
    expect(lib).toContain(`createWorkletModuleLoader("rawAudioProcessor", "${hash}"`);
  });

  test("Verbindungen nur zu Hosts aus der CSP der Gesprächsseite", () => {
    const hosts = new Set([...lib.matchAll(/\bwss:\/\/[a-z0-9.-]+/g)].map((m) => m[0]));
    expect([...hosts].sort()).toEqual(["wss://api.elevenlabs.io", "wss://livekit.rtc.elevenlabs.io"]);
    for (const host of hosts) expect(VOICE_AGENT_CONNECT_HOSTS as readonly string[]).toContain(host);
    expect(lib).toContain('"https://api.elevenlabs.io"');
  });

  test("Die Seite nutzt die Vendor-Pfade und den WebRTC-Weg (kein libsamplerate von jsDelivr)", () => {
    expect(pageSource).toContain('script: "/vendor/elevenlabs/lib.iife.js"');
    expect(pageSource).toContain('rawAudioProcessor: "/vendor/elevenlabs/rawAudioProcessor.js"');
    expect(pageSource).toContain('connectionType: "webrtc"');
    expect(pageSource).not.toContain("jsdelivr");
  });
});

describe("Auslieferung", () => {
  test("nicht öffentlich: ohne Login Umleitung zur Anmeldung, angemeldet als JavaScript", async () => {
    expect(Object.keys(PUBLIC_ASSETS).some((p) => p.startsWith("/vendor"))).toBe(false);
    const ctx = await topicServer(root, servers, null);
    for (const path of ["/vendor/elevenlabs/lib.iife.js", "/vendor/elevenlabs/rawAudioProcessor.js"]) {
      const anon = await fetch(`${ctx.origin}${path}`, { redirect: "manual" });
      expect(anon.status).toBe(302);
      expect(anon.headers.get("location")).toBe("/login");
      const res = await ctx.api(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      await res.arrayBuffer();
    }
  });
});

describe("SDK-Attrappe für web:dev (Issue #495)", () => {
  test("ersetzt nur das SDK, nur nach dem Login; ohne Abhängigkeit das eingecheckte SDK", async () => {
    expect(pageSource).toContain(`script: "${VOICE_AGENT_SDK_PATH}"`);
    const ctx = await topicServer(root, servers, null, { voiceAgentSdkScript: DEMO_VOICE_AGENT_SDK });
    const anon = await fetch(`${ctx.origin}${VOICE_AGENT_SDK_PATH}`, { redirect: "manual" });
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toBe("/login");
    await anon.arrayBuffer();
    const res = await ctx.api(VOICE_AGENT_SDK_PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await res.text()).toBe(DEMO_VOICE_AGENT_SDK);
    // Das Worklet bleibt das eingecheckte
    const worklet = await ctx.api("/vendor/elevenlabs/rawAudioProcessor.js");
    expect(await worklet.text()).toBe(readFileSync(join(DIR, "rawAudioProcessor.js"), "utf8"));

    const plain = await topicServer(root, servers, null);
    const real = await plain.api(VOICE_AGENT_SDK_PATH);
    expect(await real.text()).toBe(lib);
  });

  test("Attrappe: kein Netz, kennt Stumm, Unterbrechen und Trennen des Raums", async () => {
    expect(DEMO_VOICE_AGENT_SDK).not.toMatch(/https?:\/\/|wss?:\/\/|fetch\(|WebSocket/);
    const win: any = {};
    new Function("window", "setTimeout", "setInterval", "clearInterval", DEMO_VOICE_AGENT_SDK)(win, (fn: () => void) => fn(), () => 0, () => {});
    const events: string[] = [];
    const session = await win.ElevenLabsClient.Conversation.startSession({
      conversationToken: "t",
      connectionType: "webrtc",
      onModeChange: (e: any) => events.push(e.mode),
      onInterruption: () => events.push("unterbrochen"),
      onDisconnect: () => events.push("getrennt"),
    });
    session.setMicMuted(true);
    session.sendUserActivity();
    await session.endSession();
    await session.connection.room.disconnect();
    expect(session.connection.room.state).toBe("disconnected");
    expect(win.__demoVoiceSdk.muted).toEqual([true]);
    // Wie LiveKit: Die Mikrofonspur zeigt den Stand, den die Seite als Nachweis prüft
    const track = session.connection.room.localParticipant.getTrackPublication("microphone").track;
    expect(track).toMatchObject({ isMuted: true, mediaStreamTrack: { enabled: false, readyState: "live" } });
    await session.input.setMuted(false);
    expect(track).toMatchObject({ isMuted: false, mediaStreamTrack: { enabled: true } });
    expect(events).toEqual(["listening", "unterbrochen", "listening", "getrennt"]);
    await expect(win.ElevenLabsClient.Conversation.startSession({ conversationToken: "token-fehler" })).rejects.toThrow();
  });
});
