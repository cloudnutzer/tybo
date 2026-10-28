import { mkdir, rename, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const writes = new Map<string, Promise<void>>();
/** Serializes writes and replaces the destination only after a complete write. */
export function atomicWriteFile(path: string, content: string): Promise<void> {
  const pending = (writes.get(path) || Promise.resolve()).catch(() => {}).then(async () => {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, content, { mode: 0o600, flag: "wx" });
      await rename(temp, path);
    } finally { await unlink(temp).catch(() => {}); }
  });
  writes.set(path, pending);
  pending.finally(() => { if (writes.get(path) === pending) writes.delete(path); }).catch(() => {});
  return pending;
}
