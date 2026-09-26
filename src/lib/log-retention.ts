import { readdir, stat, open, unlink, chmod } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";

/** Copy/truncate keeps launchd's open log descriptors valid. */
export async function rotateServiceLogs(directory = "logs"): Promise<void> {
  const names = await readdir(directory).catch(() => []);
  const now = Date.now();
  for (const name of names) {
    if (!/^(telegram-relay|whatsapp-gateway|voice-bridge)(\.error)?\.log(?:\.\d+\.gz)?$/.test(name)) continue;
    const path = join(directory, name);
    const info = await stat(path);
    if (name.endsWith(".gz")) {
      if (now - info.mtimeMs > 14 * 86_400_000) await unlink(path);
    } else {
      await chmod(path, 0o600);
      if (info.size <= 10 * 1024 * 1024) continue;
      await pipeline(createReadStream(path), createGzip(), createWriteStream(`${path}.${now}.gz`, { flags: "wx", mode: 0o600 }));
      const file = await open(path, "r+");
      try { await file.truncate(0); } finally { await file.close(); }
    }
  }
}
