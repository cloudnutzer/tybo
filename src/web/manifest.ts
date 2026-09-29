/**
 * Manifest der installierbaren WebUI (Issue #224, Entscheidung 0021): Der
 * Server erzeugt /manifest.webmanifest aus src/brand.ts, damit Name und
 * Kurzname nie als feste Zeichenkette in public/ stehen.
 *
 * Teilen-Ziel (Issue #229): Android (Chrome, Edge, Samsung Internet) bietet
 * die installierte App im Teilen-Menü an und schickt Titel, Text, Link und
 * Dateien als POST an /teilen. Den POST fängt der Service Worker ab
 * (public/sw.js); der Server antwortet nur, wenn der Worker noch nicht
 * läuft, und verwirft dann alles (server.ts). Safari kennt share_target nicht.
 *
 * Nichts im Manifest verrät etwas über den Nutzer (kein Gespräch, kein
 * Agent); es ist deshalb wie das Login ohne WebUI-Sitzung erreichbar. Über
 * den Tunnel gilt der Access-Nachweis trotzdem (server.ts), der Browser holt
 * es mit crossorigin="use-credentials", also mit dem Access-Cookie.
 */

import { BRAND } from "../brand";

export const MANIFEST_PATH = "/manifest.webmanifest";
export const MANIFEST_CONTENT_TYPE = "application/manifest+json";

/** Wie --bg hell in style.css und die helle theme-color */
export const MANIFEST_BACKGROUND = "#ffffff";

export interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: "any" | "maskable";
}

/** Adresse des Teilen-Ziels, wie SHARE_PATH in public/sw.js */
export const SHARE_TARGET_PATH = "/teilen";
/** Formularfeld der Dateien, wie in public/sw.js gelesen */
export const SHARE_FILES_FIELD = "dateien";

/**
 * Dateitypen, die das Teilen-Menü anbietet: dieselben Arten wie die
 * Büroklammer (media-check.ts). Sprachdateien einzeln statt audio/*, weil der
 * Server nur diese Formate erkennt. Gleiche Liste wie SHARE_TYPES in sw.js.
 */
export const SHARE_ACCEPT = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "audio/ogg",
  "audio/opus",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
  "audio/webm",
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
];

export interface ShareTarget {
  action: string;
  method: "POST";
  enctype: "multipart/form-data";
  params: {
    title: string;
    text: string;
    url: string;
    files: { name: string; accept: string[] }[];
  };
}

export interface WebManifest {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: "standalone";
  background_color: string;
  theme_color: string;
  lang: string;
  icons: ManifestIcon[];
  share_target: ShareTarget;
}

/** Symbole in src/web/public, erzeugt von scripts/web-icons.ts (außer favicon.svg) */
export const MANIFEST_ICONS: ManifestIcon[] = [
  { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
  { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
];

export function webManifest(brand: { name: string } = BRAND): WebManifest {
  return {
    id: "/",
    name: brand.name,
    short_name: brand.name,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: MANIFEST_BACKGROUND,
    theme_color: MANIFEST_BACKGROUND,
    lang: "de",
    icons: MANIFEST_ICONS.map(icon => ({ ...icon })),
    share_target: {
      action: SHARE_TARGET_PATH,
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        title: "title",
        text: "text",
        url: "url",
        files: [{ name: SHARE_FILES_FIELD, accept: [...SHARE_ACCEPT] }],
      },
    },
  };
}

export function manifestResponse(): Response {
  return new Response(JSON.stringify(webManifest()), { headers: { "Content-Type": MANIFEST_CONTENT_TYPE } });
}
