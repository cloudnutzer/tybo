/** Die echte Quelle liest ausschließlich die begrenzte Statusdatei. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { maskSecrets, projectSecretsOrThrow } from "../lib/jobs/mask";
import { PIPELINE_STATUS_BYTES, type PipelineText } from "./pipeline-status";
import { scrubHome } from "./routines";
import { stripInvisibleChars } from "../lib/telegram";
import type { PipelinesPort } from "./pipelines";

export function createBotPipelines({ root, home = homedir() }: { root: string; home?: string }): PipelinesPort {
  return {
    display() {
      const secrets = projectSecretsOrThrow(root);
      return pipelineText(text => maskSecrets(text, secrets), home);
    },
    async read() {
      let file;
      try { file = await open(join(root, "data", "pipeline-status.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > PIPELINE_STATUS_BYTES) throw new Error("Ungültige Statusdatei");
        // Ein weiteres Byte bemerkt Wachstum nach stat(), ohne unbegrenzt zu lesen.
        const buffer = Buffer.alloc(PIPELINE_STATUS_BYTES + 1);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > PIPELINE_STATUS_BYTES) throw new Error("Statusdatei zu groß");
        const value: unknown = JSON.parse(buffer.subarray(0, size).toString("utf8"));
        if (value === null) throw new Error("Ungültiger Status");
        return value;
      } finally { await file.close(); }
    },
  };
}

/** Erst vollständig maskieren und Pfade entfernen, danach kürzen. */
export function pipelineText(mask: (text: string) => string, home: string): PipelineText {
  return (value, max) => {
    // Pfade vor dem Maskieren entfernen: ein ersetztes Geheimnis mitten im Pfad
    // darf durch die eckigen Klammern keinen sichtbaren Pfadrest hinterlassen.
    const pathsRemoved = scrubHome(stripInvisibleChars(value), home)
      .replace(/file:\/\/[^\s<>"'`|)\]}]+/gu, "[Pfad verborgen]")
      .replace(/(^|[\s(<\[\{"'=:`])(?:[A-Za-z]:[\\/]|\\\\|~\/|\/(?!\/))[^\s<>"'`|)\]}]+/gu, "$1[Pfad verborgen]")
      .replace(/\b(?:PID|pid)\s*[:=#]?\s*\d+\b/g, "[Prozess verborgen]")
      .trim();
    const text = mask(pathsRemoved);
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };
}
