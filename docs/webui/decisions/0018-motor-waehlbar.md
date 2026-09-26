# 0018 Motor wählbar: Schnittstelle und Codex

Datum: 25.09.2026. Entschieden von: Maintainer, Umsetzungsdetails Plan-Session.

- tybo bekommt eine allgemeine Motor-Schnittstelle (`src/lib/engines/`).
  Claude Code ist die erste Umsetzung, Verhalten und Tests bleiben dabei
  unverändert. Danach Codex (M11), dann OpenCode (M12, Entscheidung 0019).
- Ein Standard-Motor gilt für alles: `.env` (`TYBO_ENGINE`) und
  Einstellungsseite (`engine.default` in `config/settings.json`, die
  Einstellungsdatei hat Vorrang). Pro Gespräch (Topic, Direktchat,
  Web-Gespräch) überschreibbar mit `/motor <name>` in allen Kanälen,
  zurück mit `/motor standard`.
- Mit jedem Motor gehen: Chat, fortlaufende Sessions pro Topic,
  Fortschrittsanzeige, Merk-Tags inklusive Erkennung fremder Inhalte,
  `/stop`. Eine Session gehört zu genau einem Motor; ein Wechsel beginnt eine
  neue Session, das Gedächtnis bleibt. Destillat, `/routine` und Fortsetzungen
  laufen über den Motor der Session.
- MCP-Server und Skills kommen aus der Konfiguration des jeweiligen Motors;
  tybo schreibt dort nichts. Hooks und die `CLAUDE.md`-Automatik gibt es nur
  bei Claude Code. Codex liest dieselbe `CLAUDE.md` über
  `project_doc_fallback_filenames` (keine zweite Datei im Repo).
- Codex läuft mit der ChatGPT-Anmeldung aus `codex login`. Entschieden
  (Maintainer, 25.09.2026): Rechte-Stufe „Voller Zugriff" als Standard, Codex darf
  wie Claude alles; einstellbar auf „Projekt schreiben" oder „Nur lesen".
- Modelle pro Agent gelten für Claude Code; für Codex gibt es Modell, Effort
  und Rechte je Motor (leer = Codex-Konfiguration).
- Die Fallback-Kette (`src/lib/fallback-llm.ts`) bleibt und greift, wenn der
  gewählte Motor ausfällt. Ist ein Motor nicht installiert oder nicht
  angemeldet, antwortet Claude Code mit einem Hinweis.
- Bleiben bei Claude: VPS-Modus (`src/vps-gateway.ts`, Agent SDK),
  Hintergrund-Jobs, Check-in, Aux-Modelle, WhatsApp.
