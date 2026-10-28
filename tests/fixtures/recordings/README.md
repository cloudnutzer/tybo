# Aufnahme-Proben (Issue #109)

Kleine echte Dateien für die Typprüfung (`tests/web-recording-media.test.ts`).

- `chrome-opus.webm`, `chrome-aac.mp4`, `chrome-opus.mp4`: 1,5 s MediaRecorder-Aufnahmen
  aus Headless-Chrome 154 (`--use-fake-device-for-media-stream`) mit
  `audio/webm;codecs=opus`, `audio/mp4;codecs=mp4a.40.2` und `audio/mp4`
  (Chrome wählt dafür Opus in MP4, Marke `isom`).
- `fragmented-iso5-aac.mp4`: fragmentiertes MP4 mit AAC und Marke `iso5`, wie
  es Safari schreibt; ffmpeg `-c:a aac -movflags frag_keyframe+empty_moov+default_base_moof -brand iso5`.
- `moov-end-aac.mp4`: nicht fragmentiertes MP4 mit AAC, Marke `mp42`, moov am Ende (ffmpeg-Standard).
- `video-only.mp4`, `audio-video.mp4`: Proben mit Videospur (ffmpeg, moov am Ende), keine
  Sprachdateien, sondern Videos.

## Video-Anhang

Kleine Videos (32x32 Pixel, 0,4 s, Testbild von ffmpeg) für die Erkennung als Video:

- `video-quicktime.mov`: H.264 und AAC mit Zeitcode-Spur (`-timecode`), Marke `qt  `, wie vom iPhone.
- `video-faststart.mp4`: H.264, moov am Anfang (`-movflags +faststart`).
- `video-vp8-opus.webm`: VP8 und Opus.
- `video-mpeg4.mkv`: MPEG-4 Part 2 in Matroska.

## Sprechmodus (Issue #249)

Für das Lesen der AAC-Frames (`tests/web-audio-duration.test.ts`). Beide aus
künstlichem Ton (Rauschen, Sinustöne, kurze Impulse), keine Sprache.

- `stereo-aac.m4a`: AAC-LC, Stereo, 44,1 kHz, 32 Frames, Encoder von ffmpeg mit
  allen Werkzeugen (`-c:a aac -b:a 56k -aac_pns 1 -aac_is 1 -aac_ms 1 -aac_tns 1`):
  kurze Fenster, Mitte/Seite, Intensität, Rauschen, alle elf Codebücher.
- `apple-aac.m4a`: AAC-LC, Stereo, 24 kHz, 19 Frames, Encoder von macOS
  (`afconvert -f m4af -d aac -b 48000`): TNS in langen und kurzen Fenstern,
  Mitte/Seite-Maske je Band, zwei Chunks.
