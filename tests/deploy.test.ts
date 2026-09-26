import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("deployment validates first and rolls back an unhealthy release", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tybo-deploy-"));
  const bin = join(dir, "bin"), source = join(dir, "source"), root = join(dir, "root");
  await Promise.all([mkdir(bin), mkdir(source), mkdir(root)]);
  try {
    await mkdir(join(source, "src")); await mkdir(join(source, "tests"));
    for (const name of ["bun.lock", "src/whatsapp-gateway.ts", "src/voice-bridge.ts", "tests/.keep"])
      await writeFile(join(source, name), "fixture");
    const script = join(dir, "deploy.sh");
    await copyFile(resolve("deploy.sh"), script);
    const commands: Record<string, string> = {
      git: '#!/bin/sh\ncase "$3" in rev-parse) echo abc123;; archive) tar -C "$FIXTURE_SOURCE" -cf - .;; esac\n',
      bun: '#!/bin/sh\nif [ "$1" = "run" ]; then [ "$FAIL_CHECK" != "yes" ]; elif [ "$1" = "install" ]; then exit 0; else exec "$REAL_BUN" "$@"; fi\n',
      pm2: '#!/bin/sh\necho "$*" >> "$PM2_LOG"\nif [ "$1" = "jlist" ]; then echo "[{\\"name\\":\\"vps-app\\",\\"pm2_env\\":{\\"pm_exec_path\\":\\"/previous/app.ts\\",\\"pm_cwd\\":\\"/previous\\",\\"exec_interpreter\\":\\"bun\\",\\"env\\":{}}}]"; fi\n',
      curl: '#!/bin/sh\nif [ "$UNHEALTHY" = "yes" ]; then echo \'{"status":"ok","revision":"old"}\'; else echo \'{"status":"ok","revision":"abc123"}\'; fi\n',
      sleep: '#!/bin/sh\nexit 0\n',
    };
    for (const [name, content] of Object.entries(commands)) await writeFile(join(bin, name), content, { mode: 0o700 });
    for (const scenario of ["failed-check", "unhealthy", "healthy"]) {
      const releases = join(dir, scenario), log = join(dir, `${scenario}.log`);
      const child = Bun.spawn(["bash", script], { env: { PATH: `${bin}:${process.env.PATH}`, REAL_BUN: process.execPath,
        FIXTURE_SOURCE: source, PM2_LOG: log, DEPLOY_APP: "vps-app", DEPLOY_DIR: root, RELEASE_ROOT: releases,
        FAIL_CHECK: scenario === "failed-check" ? "yes" : "no", UNHEALTHY: scenario === "unhealthy" ? "yes" : "no" },
        stdout: "pipe", stderr: "pipe" });
      const exit = await child.exited;
      const operations = await readFile(log, "utf8");
      if (scenario === "failed-check") {
        expect(exit).not.toBe(0); expect(operations).not.toContain("delete");
      } else if (scenario === "unhealthy") {
        expect(exit).not.toBe(0); expect(operations).toContain("rollback.json");
      } else {
        expect(exit).toBe(0); expect(operations).not.toContain("rollback.json");
      }
    }
  } finally { await rm(dir, { recursive: true }); }
}, 15_000);
