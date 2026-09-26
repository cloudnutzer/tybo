# Aufnahme-Proben (Issue #109)

Kleine echte Dateien für die Typprüfung (`tests/web-recording-media.test.ts`).

- `chrome-opus.webm`, `chrome-aac.mp4`, `chrome-opus.mp4`: 1,5 s MediaRecorder-Aufnahmen
  aus Headless-Chrome 154 (`--use-fake-device-for-media-stream`) mit
  `audio/webm;codecs=opus`, `audio/mp4;codecs=mp4a.40.2` und `audio/mp4`
  (Chrome wählt dafür Opus in MP4, Marke `isom`).
- `fragmented-iso5-aac.mp4`: fragmentiertes MP4 mit AAC und Marke `iso5`, wie
  es Safari schreibt; ffmpeg `-c:a aac -movflags frag_keyframe+empty_moov+default_base_moof -brand iso5`.
- `moov-end-aac.mp4`: nicht fragmentiertes MP4 mit AAC, Marke `mp42`, moov am Ende (ffmpeg-Standard).
- `video-only.mp4`, `audio-video.mp4`: Gegenproben mit Videospur (ffmpeg), müssen abgelehnt werden.
