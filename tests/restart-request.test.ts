import { test, expect, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requestRestart,
  readRestartRequest,
  clearRestartRequest,
  detectSupervisor,
  supervisorLabels,
} from "../src/lib/restart-request";
import { oldLaunchdLabel } from "./old-names";

const OLD = oldLaunchdLabel("telegram-relay");

const dir = await mkdtemp(join(tmpdir(), "tybo-restart-"));
const marker = join(dir, "nested", "restart-requested");

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("no marker → null", async () => {
  expect(await readRestartRequest(marker)).toBeNull();
});

test("request creates marker (with parent dir) and stores the trimmed note", async () => {
  await requestRestart("  Tabellen-Fix aktivieren \n", marker);
  expect(await readRestartRequest(marker)).toBe("Tabellen-Fix aktivieren");
});

test("request without note → empty string, not null", async () => {
  await requestRestart("", marker);
  expect(await readRestartRequest(marker)).toBe("");
});

test("clear removes the marker and is idempotent", async () => {
  await clearRestartRequest(marker);
  expect(await readRestartRequest(marker)).toBeNull();
  await clearRestartRequest(marker); // second call must not throw
});

// Never the real launchctl: it would query the running bot's service on this Mac
const launchdOutput = (pid: number, label = "ai.tybo.telegram-relay") => `{\n\t"Label" = "${label}";\n\t"PID" = ${pid};\n};\n`;

test("detectSupervisor: a pid that is not the supervised bot → null", async () => {
  const deps = { env: {}, platform: "darwin" as const, launchctlList: async () => launchdOutput(4242) };
  expect(await detectSupervisor(-1, deps)).toBeNull();
});

/** launchctl-Attrappe: nur die angegebenen Labels sind geladen, jedes mit seiner PID */
function fakeLaunchctl(loaded: Record<string, number>) {
  const asked: string[] = [];
  return {
    asked,
    launchctlList: async (label: string) => {
      asked.push(label);
      if (!(label in loaded)) throw new Error("Could not find service");
      return launchdOutput(loaded[label], label);
    },
  };
}

test("detectSupervisor: a bot under the old label is not asked for and never counts (Issue #142)", async () => {
  const f = fakeLaunchctl({ [OLD]: 4242 });
  expect(await detectSupervisor(4242, { env: {}, platform: "darwin", launchctlList: f.launchctlList })).toBeNull();
  expect(f.asked).toEqual(["ai.tybo.telegram-relay"]);
});

test("detectSupervisor: launchd under the new label ai.tybo.telegram-relay", async () => {
  const f = fakeLaunchctl({ "ai.tybo.telegram-relay": 4242 });
  expect(await detectSupervisor(4242, { env: {}, platform: "darwin", launchctlList: f.launchctlList })).toBe("launchd");
  expect(f.asked).toEqual(["ai.tybo.telegram-relay"]);
});

test("detectSupervisor: another label's PID never counts, even with a matching PID elsewhere", async () => {
  // Neuer Dienst läuft mit fremder PID, alter mit fremder PID: nicht wir
  const f = fakeLaunchctl({ "ai.tybo.telegram-relay": 1111, [OLD]: 2222 });
  expect(await detectSupervisor(4242, { env: {}, platform: "darwin", launchctlList: f.launchctlList })).toBeNull();
  // Antwort nennt ein anderes Label als gefragt: zählt nicht
  const wrong = { env: {}, platform: "darwin" as const, launchctlList: async () => launchdOutput(4242, "ai.tybo.telegram-relay-alt") };
  expect(await detectSupervisor(4242, wrong)).toBeNull();
});

test("detectSupervisor: configured label (TYBO_LAUNCHD_LABEL) is asked first", async () => {
  const f = fakeLaunchctl({ "com.example.bot": 4242 });
  expect(await detectSupervisor(4242, { env: { TYBO_LAUNCHD_LABEL: "com.example.bot" }, platform: "darwin", launchctlList: f.launchctlList })).toBe("launchd");
  expect(f.asked).toEqual(["com.example.bot"]);
  expect(supervisorLabels({ TYBO_LAUNCHD_LABEL: "x" })).toEqual(["x", "ai.tybo.telegram-relay"]);
  expect(supervisorLabels({ TYBO_LAUNCHD_LABEL: "ai.tybo.telegram-relay" })).toEqual(["ai.tybo.telegram-relay"]);
  expect(supervisorLabels({})).toEqual(["ai.tybo.telegram-relay"]);
});

test("detectSupervisor: label not loaded → null, does not throw", async () => {
  const deps = {
    env: {},
    platform: "darwin" as const,
    launchctlList: async () => {
      throw new Error("Could not find service");
    },
  };
  expect(await detectSupervisor(4242, deps)).toBeNull();
});

test("detectSupervisor: pm_id set → pm2; other platforms never ask launchctl", async () => {
  const never = async () => {
    throw new Error("launchctl must not be called");
  };
  expect(await detectSupervisor(1, { env: { pm_id: "0" }, platform: "darwin", launchctlList: never })).toBe("pm2");
  expect(await detectSupervisor(1, { env: {}, platform: "linux", launchctlList: never })).toBeNull();
});
