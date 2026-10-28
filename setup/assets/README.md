# Probe-Aufnahmen der Einrichtung

`parakeet-probe-de.wav` und `parakeet-probe-de.txt` (Issue #251): kurze
deutsche Aufnahme für die Probe im Schritt `sprache` (`tybo setup sprache`),
mit dem Solltext daneben.

- Herkunft: am 01.10.2026 per Sprachsynthese erzeugt, mit Qwen3-TTS
  (`mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit`, Stimme `vivian`,
  Sprache `de`; Modell unter Apache-2.0), dann mit ffmpeg auf WAV (PCM16,
  16 kHz, mono) gewandelt, ohne Metadaten. Gesprochen wird genau der
  Solltext.
- Kennzeichnung: Die WAV trägt im `LIST/INFO`-Block den Hinweis
  „KI-generiert (tybo)“ (`ICMT`, `ISFT`), wie alle erzeugten WAV-Dateien
  (Entscheidung 0023).
- Lizenz: CC0 1.0 (gemeinfrei, https://creativecommons.org/publicdomain/zero/1.0/).
- Länge 10,8 Sekunden, 345.698 Byte.
