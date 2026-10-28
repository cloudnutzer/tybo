# 0019 OpenCode als dritter Motor

Datum: 25.09.2026. Entschieden von: Maintainer (Reihenfolge nach Codex), Umsetzungsdetails Plan-Session.

- OpenCode kommt hinter dieselbe Schnittstelle wie Codex (0018) und ist
  genauso wählbar: Standard-Motor, `/motor opencode`, Einstellungsseite mit
  Modell, Variante (Effort) und Rechten; Modell-Liste aus `opencode models`.
- Entschieden (Maintainer, 25.09.2026, Anbieter OpenRouter): unterstützt wird OpenCode V1 (npm `opencode-ai`,
  `opencode run --format json`). V1 liest die `CLAUDE.md` des Projekts und
  `~/.claude/skills` von selbst. V2 (`@opencode/cli`) hat einen
  Hintergrunddienst, eine andere Effort-Angabe und liest nur `AGENTS.md`; es
  wird erkannt und mit Hinweis abgelehnt, bis es eigens eingeplant ist.
- Anmeldung und Anbieter kommen aus OpenCode (`opencode auth login`). Claude
  Pro/Max ist in OpenCode nicht erlaubt; sinnvoll sind die ChatGPT-Anmeldung,
  OpenRouter oder ein API-Schlüssel; der Maintainer nutzt OpenRouter
  (`opencode auth login -p openrouter`). Anbieter-Schlüssel erbt der Prozess nur
  über `TYBO_SUBPROCESS_ENV_ALLOW`.
- Ohne Rückfragen mit `--auto` (Standard), einstellbar auf „Fragen ablehnen".
- OpenCode meldet Werkzeuge erst nach ihrem Ende; die Fortschrittsanzeige ist
  deshalb etwas später als bei Claude und Codex. Kein Server-Betrieb
  (`opencode serve`) in M12.
