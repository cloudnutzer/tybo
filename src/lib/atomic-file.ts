import { mkdir, rename, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const writes = new Map<string, Promise<void>>();
/** Serializes writes and replaces the destination only after a complete write. */
export function atomicWriteFile(path: string, content: string, options: { signal?: AbortSignal } = {}): Promise<void> {
  const pending = (writes.get(path) || Promise.resolve()).catch(() => {}).then(async () => {
    options.signal?.throwIfAborted();
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      options.signal?.throwIfAborted();
      await writeFile(temp, content, { mode: 0o600, flag: "wx", signal: options.signal });
      options.signal?.throwIfAborted();
      await rename(temp, path);
    } finally { await unlink(temp).catch(() => {}); }
  });
  writes.set(path, pending);
  pending.finally(() => { if (writes.get(path) === pending) writes.delete(path); }).catch(() => {});
  return pending;
}
