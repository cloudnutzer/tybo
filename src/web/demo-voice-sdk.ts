/**
 * SDK-Attrappe für web:dev (Issue #495): ersetzt dort hinter dem Login
 * /vendor/elevenlabs/lib.iife.js, damit sich die Gesprächsseite /sa/<kennung>
 * ohne Anbieter durchspielen lässt. Kein Netz, kein Mikrofon (das öffnet die
 * Seite selbst), keine echte Sprache: Die Attrappe wechselt alle paar Sekunden
 * zwischen Zuhören und Sprechen, kennt Stumm (input.setMuted schaltet die
 * Mikrofonspur wie LiveKit erst kurz danach um) und Unterbrechen (sendUserActivity; kurz danach bestätigt sie
 * wie der Server mit onInterruption) und trennt ihren „Raum“ wie das SDK erst
 * kurz nach endSession(). Nur web:dev setzt sie (Abhängigkeit voiceAgentSdkScript des
 * Web-Servers); der Bot liefert immer das eingecheckte SDK.
 */
export const DEMO_VOICE_AGENT_SDK = `"use strict";
// SDK-Attrappe aus src/web/demo-voice-sdk.ts (nur web:dev)
(function () {
  var calls = (window.__demoVoiceSdk = { started: [], ended: 0, muted: [], activity: 0 });
  window.ElevenLabsClient = {
    Conversation: {
      startSession: function (o) {
        calls.started.push({ token: o.conversationToken, connectionType: o.connectionType });
        return new Promise(function (resolve, reject) {
          setTimeout(function () {
            if (String(o.conversationToken).indexOf("fehler") >= 0) return reject(new Error("Attrappe: keine Verbindung"));
            var room = {
              state: "connected",
              disconnect: function () {
                return new Promise(function (r) {
                  setTimeout(function () { room.state = "disconnected"; r(); }, 150);
                });
              },
            };
            // Mikrofonspur wie bei LiveKit: input.setMuted schaltet sie kurz danach um
            var track = { isMuted: false, mediaStreamTrack: { enabled: true, readyState: "live" } };
            room.localParticipant = {
              getTrackPublication: function (source) { return source === "microphone" ? { track: track } : undefined; },
            };
            var input = {
              setMuted: function (muted) {
                calls.muted.push(Boolean(muted));
                return new Promise(function (r) {
                  setTimeout(function () {
                    track.isMuted = Boolean(muted);
                    track.mediaStreamTrack.enabled = !muted;
                    r();
                  }, 200);
                });
              },
              isMuted: function () { return track.isMuted; },
            };
            var speaking = false;
            var timer = setInterval(function () {
              if (room.state !== "connected") return clearInterval(timer);
              speaking = !speaking;
              if (o.onModeChange) o.onModeChange({ mode: speaking ? "speaking" : "listening" });
            }, 4000);
            var session = {
              connection: { room: room },
              endSession: function () {
                calls.ended++;
                clearInterval(timer);
                room.disconnect();
                if (o.onDisconnect) o.onDisconnect({ reason: "user" });
                return Promise.resolve();
              },
              input: input,
              setMicMuted: function (muted) { input.setMuted(muted); },
              sendUserActivity: function () {
                calls.activity++;
                // Wie der Server: Das Unterbrechen kommt als eigenes Ereignis zurück
                setTimeout(function () {
                  if (room.state !== "connected") return;
                  speaking = false;
                  if (o.onInterruption) o.onInterruption({ event_id: calls.activity });
                  if (o.onModeChange) o.onModeChange({ mode: "listening" });
                }, 400);
              },
            };
            if (o.onConversationCreated) o.onConversationCreated(session);
            if (o.onModeChange) o.onModeChange({ mode: "listening" });
            resolve(session);
          }, 300);
        });
      },
    },
  };
})();
`;
