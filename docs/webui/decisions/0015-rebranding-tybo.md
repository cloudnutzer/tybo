# 0015 Produktname tybo

Datum: 25.09.2026. Entschieden von: Maintainer.

- Name, Befehl und Domain: **tybo**, `tybo`, **tybo.ai** (`src/brand.ts`).
  Sichtbare Texte (WebUI, Telegram, Terminal, Einrichtung, README, CLAUDE.md,
  Doku) nennen tybo.
- Umgebungsvariablen heißen `TYBO_*`.
- Hintergrunddienste heißen `ai.tybo.*` (launchd) und `tybo-*` (PM2), die
  Namen stehen in `src/lib/service-names.ts`. Einziger Befehl ist `tybo`.
- Gespeicherte Namen heißen nach tybo: Cookie `tybo_web`, Browser-Speicher
  `tybo-*`, `config/patterns.md`.
- Der Supabase-Bucket kommt aus `SUPABASE_ASSETS_BUCKET` (Standard
  `tybo-assets`). Datenordner, Log-Dateien und Tabellen behalten ihre Namen,
  weil daran gespeicherte Daten hängen.
