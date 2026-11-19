import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseJobQuestion, QUESTION_MAX_BYTES, readJobQuestion, safeAnswer, safeQuestion } from "../src/lib/jobs/question-file";
import { jobPrompt, resumePrompt, runWatcher } from "../src/lib/jobs/runner";
import { jobFile, readStatus, writeStatus, type JobStatus } from "../src/lib/jobs/store";
import { fakeChild, fakeDeps, tempRoot } from "./jobs-fixture";

const id = "20261118-150000-000624";
const sessionId = "12345678-1234-4234-8234-123456789abc";
const question = { frage: "A oder B?", antworten: ["A", "B"], kontext: "Bitte auswählen." };
let root: string, cleanup: () => void, status: JobStatus;
beforeEach(async () => {
  ({ root, cleanup } = tempRoot("job-question-file-"));
  status = { version: 1, id, title: "Test", createdAt: new Date().toISOString(), phase: "starting",
    maxHours: 1, fullAccess: false, target: {}, sessionId };
  await writeStatus(root, status);
  await Bun.write(jobFile(root, id, "brief"), "Frag mich.");
});
afterEach(() => cleanup());

test("Format: 1 bis 8 Antworten, nur drei bekannte Felder und begrenzte Texte", () => {
  expect(parseJobQuestion(question)).toEqual(question);
  expect(parseJobQuestion({ ...question, antworten: [" A "] })?.antworten).toEqual(["A"]);
  expect(parseJobQuestion({ ...question, antworten: Array.from({ length: 8 }, (_, i) => String(i)) })).not.toBeNull();
  for (const bad of [null, [], "Text", {}, { ...question, extra: true }, { ...question, frage: " " },
    { ...question, frage: "a".repeat(501) }, { ...question, kontext: "a".repeat(1001) },
    { ...question, antworten: [] }, { ...question, antworten: ["A", " A "] },
    { ...question, antworten: ["a".repeat(81)] }, { ...question, antworten: [42] },
    { ...question, antworten: Array.from({ length: 9 }, (_, i) => String(i)) }, { ...question, frage: "A\u0000B" }]) {
    expect(parseJobQuestion(bad)).toBeNull();
  }
});

test("fehlende, kaputte und zu große Dateien; Links und Verzeichnisse werden abgelehnt", async () => {
  const path = jobFile(root, id, "question");
  expect(await readJobQuestion(root, status, [])).toEqual({ kind: "missing" });
  for (const raw of ["kaputt", " ".repeat(QUESTION_MAX_BYTES + 1), JSON.stringify({ frage: "A?" })]) {
    writeFileSync(path, raw);
    expect((await readJobQuestion(root, status, [])).kind).toBe("invalid");
  }
  const { unlinkSync } = await import("node:fs");
  unlinkSync(path);
  writeFileSync(join(root, "extern.json"), JSON.stringify(question));
  symlinkSync(join(root, "extern.json"), path);
  expect((await readJobQuestion(root, status, [])).kind).toBe("invalid");
  unlinkSync(path);
  mkdirSync(path);
  expect((await readJobQuestion(root, status, [])).kind).toBe("invalid");
});

test("Maskierung vor jeder Ablage: alle Texte, Darstellungen und Session-ID", async () => {
  writeFileSync(jobFile(root, id, "question"), JSON.stringify({ frage: "geheim**wert**?", kontext: sessionId, antworten: ["geheimwert", "B"] }));
  const result = await readJobQuestion(root, status, ["geheimwert"]);
  expect(result.kind).toBe("valid");
  expect(JSON.stringify(result)).not.toContain("geheim");
  expect(JSON.stringify(result)).not.toContain(sessionId);
});

test("Maskierung kurzer Werte kann weder Frage noch Antwort über die Versandgrenzen aufblähen", () => {
  const masked = safeQuestion({ frage: "x".repeat(500), kontext: "x".repeat(1000), antworten: ["x".repeat(80)] }, ["x"]);
  expect(masked).toEqual({ frage: "[verborgen]", kontext: "[verborgen]", antworten: ["[verborgen]"] });
  expect(safeAnswer("x".repeat(2000), ["x"])).toBe("[verborgen]");
});

test.each([{ engine: "codex" }, { workDir: "/entwurf" }, { sessionId: undefined }] as Partial<JobStatus>[])(
  "ausgeschlossene Jobs ignorieren frage.json und bekommen keinen Zusatz: %j", async over => {
    const excluded = { ...status, ...over };
    writeFileSync(jobFile(root, id, "question"), JSON.stringify(question));
    expect(await readJobQuestion(root, excluded, [])).toEqual({ kind: "ignored" });
    expect(jobPrompt(root, id, "Auftrag", excluded.workDir, "", excluded)).not.toContain("frage.json");
  });

test("Anfang und Fortsetzung nennen Format und verbleibende Fragen", () => {
  expect(jobPrompt(root, id, "Auftrag", undefined, "", status)).toContain("noch 5 verfügbar");
  const prompt = resumePrompt(root, { ...status, questionCount: 4 });
  expect(prompt).toContain("noch 1 verfügbar");
  expect(prompt).toContain("Beende danach den Turn ohne Bericht");
  expect(prompt).toContain(jobFile(root, id, "question"));
});

test.each([0, 7])("ungültige Frage mit Bericht bei Exit %s: Hinweis und kein stiller Erfolg", async code => {
  const deps = fakeDeps(root, { spawnClaude: () => {
    writeFileSync(jobFile(root, id, "question"), "{}");
    writeFileSync(jobFile(root, id, "report"), "Fertig");
    return fakeChild(60001, Promise.resolve({ code, signal: null }));
  } });
  await runWatcher(id, deps);
  expect(await readStatus(root, id)).toMatchObject({ outcome: code === 0 ? "no_report" : "failed" });
  expect(deps.sent).toHaveLength(1);
  expect(deps.sent[0].text).toContain("frage.json ist ungültig");
  expect(deps.sent[0].text).toContain(code === 0 ? "Job ohne Bericht" : "Job fehlgeschlagen");
});
