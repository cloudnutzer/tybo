/**
 * Kindprozess für tests/threads-store.test.ts: legt in der Ablage argv[2]
 * Fäden an, Fragen aus argv[3] (durch | getrennt), im Web-Gespräch argv[4].
 */
import { createThread, setThreadsFileForTests } from "../../../src/lib/threads/store";

const [file, questions, conversationId] = process.argv.slice(2);
setThreadsFileForTests(file);
console.log = () => {};
const out: string[] = [];
for (const question of questions.split("|")) {
  const r = await createThread({ conversation: { type: "web", conversationId }, topic: "Thema", context: "Kontext.", question });
  out.push(r.status);
}
process.stdout.write(JSON.stringify(out));
