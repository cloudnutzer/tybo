/**
 * Issue #164, Checkbox 1: supabase/config.toml für Supabase auf diesem
 * Rechner. project_id und Ports sind festgehalten: Eine andere project_id
 * hieße neue, leere Docker-Volumes (supabase_<dienst>_<project_id>), andere
 * Ports eine andere Adresse in der .env. Die Einstellungen der Edge
 * Functions (Issue #162) bleiben erhalten.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SUPABASE_DIR = join(resolve(import.meta.dir, ".."), "supabase");
const config = Bun.TOML.parse(readFileSync(join(SUPABASE_DIR, "config.toml"), "utf8")) as any;

describe("supabase/config.toml", () => {
  test("project_id ist tybo (Volumes supabase_<dienst>_tybo)", () => {
    expect(config.project_id).toBe("tybo");
  });

  test("eigener Portblock 544xx", () => {
    expect(config.api.port).toBe(54421);
    expect(config.db.port).toBe(54422);
    expect(config.db.shadow_port).toBe(54420);
    expect(config.db.pooler.port).toBe(54429);
    expect(config.studio.port).toBe(54423);
    expect(config.local_smtp.port).toBe(54424);
    expect(config.analytics.port).toBe(54427);
    expect(config.edge_runtime.inspector_port).toBe(54428);
    // Kein Port aus dem Standardblock 543xx mehr
    expect(readFileSync(join(SUPABASE_DIR, "config.toml"), "utf8")).not.toMatch(/^\s*[a-z_]*port\s*=\s*543\d\d/m);
  });

  test("Storage an, Pooler aus, kein seed.sql", () => {
    expect(config.storage.enabled).toBe(true);
    expect(config.db.pooler.enabled).toBe(false);
    expect(config.db.seed.enabled).toBe(false);
  });

  test("Edge Functions behalten verify_jwt = false", () => {
    for (const name of ["store-telegram-message", "search-memory", "embed-knowledge"]) {
      expect(config.functions[name].verify_jwt).toBe(false);
    }
  });

  test("supabase/.gitignore schließt .temp und .branches aus", () => {
    const lines = readFileSync(join(SUPABASE_DIR, ".gitignore"), "utf8").split("\n").map(l => l.trim());
    expect(lines).toContain(".temp");
    expect(lines).toContain(".branches");
  });
});
