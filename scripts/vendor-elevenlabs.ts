#!/usr/bin/env bun
/**
 * Selbst gehostetes SDK des Anbieters für Web-Gespräche mit Sprachagenten
 * (Issue #494, Vorgaben aus #245): holt @elevenlabs/client in der genannten
 * Version aus der npm-Registry, prüft die Integrität des Pakets (dist.integrity)
 * und schreibt nach src/web/public/vendor/elevenlabs/:
 *
 * - lib.iife.js: fertige Datei mit der globalen Variable ElevenLabsClient,
 *   enthält livekit-client für WebRTC
 * - rawAudioProcessor.js: das einzige Worklet, das der WebRTC-Weg lädt; ohne
 *   eigene Datei käme es aus blob: oder data:, was die CSP verbietet
 * - LICENSE-elevenlabs-client.txt (MIT), LICENSE-livekit-client.txt (Apache-2.0)
 * - VERSION.json: Paketversionen und SHA-256 je Datei, geprüft von
 *   tests/voice-agent-vendor.test.ts
 *
 * Kein npm-Paket zur Laufzeit, kein CDN. Ausgeliefert nur hinter dem Login.
 * libsamplerate (sonst von jsDelivr) braucht nur der WebSocket-Weg, den die
 * Gesprächsseite nicht nutzt.
 *
 *   bun run scripts/vendor-elevenlabs.ts            # Version aus VERSION.json
 *   bun run scripts/vendor-elevenlabs.ts 1.36.0     # andere Version
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const OUT = resolve(import.meta.dir, "..", "src", "web", "public", "vendor", "elevenlabs");
const REGISTRY = "https://registry.npmjs.org";

interface Fetched {
  version: string;
  dir: string;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Paket laden, Integrität prüfen, in einen eigenen leeren Ordner entpacken */
async function fetchPackage(name: string, version: string, work: string): Promise<Fetched> {
  const meta = (await (await fetch(`${REGISTRY}/${name}/${version}`)).json()) as any;
  const tarball = meta?.dist?.tarball;
  const integrity = meta?.dist?.integrity;
  if (typeof tarball !== "string" || typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    throw new Error(`${name}@${version}: keine Angaben zu Paket und Integrität in der Registry`);
  }
  const data = Buffer.from(await (await fetch(tarball)).arrayBuffer());
  const actual = `sha512-${createHash("sha512").update(data).digest("base64")}`;
  if (actual !== integrity) throw new Error(`${name}@${version}: Integrität stimmt nicht (${actual} statt ${integrity})`);
  const dir = await mkdtemp(join(work, "paket-"));
  const file = join(dir, "paket.tgz");
  await writeFile(file, data);
  const tar = Bun.spawnSync(["tar", "-xzf", file, "-C", dir]);
  if (tar.exitCode !== 0) throw new Error(`${name}@${version}: entpacken gescheitert`);
  return { version: meta.version, dir: join(dir, "package") };
}

async function main(): Promise<void> {
  let wanted = process.argv[2];
  if (!wanted) {
    const current = JSON.parse(await readFile(join(OUT, "VERSION.json"), "utf8"));
    wanted = current.pakete["@elevenlabs/client"];
  }
  if (!/^\d+\.\d+\.\d+$/.test(wanted ?? "")) throw new Error("Version wie 1.35.0 angeben");
  const work = await mkdtemp(join(tmpdir(), "vendor-elevenlabs-"));
  try {
    const client = await fetchPackage("@elevenlabs/client", wanted!, work);
    const pkg = JSON.parse(await readFile(join(client.dir, "package.json"), "utf8"));
    // Version aus der Abhängigkeit (^x.y.z): nur für die Lizenzdatei
    const livekitVersion = String(pkg.dependencies?.["livekit-client"] ?? "").replace(/^[\^~]/, "");
    const livekit = await fetchPackage("livekit-client", livekitVersion, work);

    const files: Record<string, Buffer> = {
      "lib.iife.js": await readFile(join(client.dir, "dist", "lib.iife.js")),
      "rawAudioProcessor.js": await readFile(join(client.dir, "worklets", "rawAudioProcessor.js")),
      "LICENSE-elevenlabs-client.txt": await readFile(join(client.dir, "LICENSE")),
      "LICENSE-livekit-client.txt": await readFile(join(livekit.dir, "LICENSE")),
    };
    await rm(OUT, { recursive: true, force: true });
    await mkdir(OUT, { recursive: true });
    const sums: Record<string, string> = {};
    for (const [name, data] of Object.entries(files)) {
      await writeFile(join(OUT, name), data);
      sums[name] = sha256(data);
    }
    const version = { pakete: { "@elevenlabs/client": client.version, "livekit-client": livekit.version }, sha256: sums };
    await writeFile(join(OUT, "VERSION.json"), JSON.stringify(version, null, 2) + "\n");
    console.log(`@elevenlabs/client ${client.version}, livekit-client ${livekit.version} nach ${OUT}`);
    for (const [name, sum] of Object.entries(sums)) console.log(`${sum}  ${name}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

await main();
