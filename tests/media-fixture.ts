// Testdaten für den Medien-Kern (Issue #71): kleinste Dateiköpfe je Art.

export function bytes(...parts: (number[] | string | Uint8Array)[]): Uint8Array {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === "string") out.push(...[...p].map(c => c.charCodeAt(0)));
    else out.push(...p);
  }
  return new Uint8Array(out);
}

/** Auf genau n Bytes auffüllen (Kopf bleibt vorne) */
export function padTo(head: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  out.set(head.subarray(0, n));
  return out;
}

const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

export const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13], "IHDR");
export const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16], "JFIF");
export const GIF87 = bytes("GIF87a", [1, 0, 1, 0]);
export const GIF89 = bytes("GIF89a", [1, 0, 1, 0]);
export const WEBP = bytes("RIFF", [36, 0, 0, 0], "WEBPVP8 ");
export const PDF = bytes("%PDF-1.7\n");
export const WAV = bytes("RIFF", [36, 0, 0, 0], "WAVEfmt ");
export const MP3_ID3 = bytes("ID3", [4, 0, 0, 0, 0, 0, 0]);
export const MP3_SYNC = bytes([0xff, 0xfb, 0x90, 0x64]);
export const MP3_SYNC_E = bytes([0xff, 0xe3, 0x18, 0xc4]);
export const SVG = bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

/** OGG-Seite mit einem Paket */
export function oggPage(packet: Uint8Array | string): Uint8Array {
  const p = typeof packet === "string" ? bytes(packet) : packet;
  return bytes("OggS", [0, 0x02], new Array(20).fill(0), [1, p.length], p);
}
export const OGG_OPUS = oggPage(bytes("OpusHead", [1, 2, 0x38, 1, 0x80, 0xbb, 0, 0, 0, 0, 0]));

/** OGG-Seite mit frei gewählten Lacing-Werten, etwa [4, 4]: zwei Pakete */
export function oggPageLacing(lacing: number[], payload: Uint8Array | string): Uint8Array {
  const p = typeof payload === "string" ? bytes(payload) : payload;
  return bytes("OggS", [0, 0x02], new Array(20).fill(0), [lacing.length, ...lacing], p);
}

/** ftyp-Box mit Haupt- und Neben-Marken */
export function ftyp(major: string, ...compatible: string[]): Uint8Array {
  const size = 16 + 4 * compatible.length;
  return bytes(u32be(size), "ftyp", major, [0, 0, 0, 0], ...compatible, [0, 0, 0, 8], "free");
}

// --- EBML / WebM ---
function ebmlSize(n: number): number[] {
  if (n < 0x7f) return [0x80 | n];
  return [0x10 | ((n >>> 24) & 0x0f), (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
export function el(id: number[], ...children: Uint8Array[]): Uint8Array {
  const payload = bytes(...children);
  return bytes(id, ebmlSize(payload.length), payload);
}
/** Element mit unbekannter Größe (Live-Aufnahmen aus MediaRecorder) */
export function elUnknown(id: number[], ...children: Uint8Array[]): Uint8Array {
  return bytes(id, [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], ...children);
}
export const ID = {
  EBML: [0x1a, 0x45, 0xdf, 0xa3],
  DocType: [0x42, 0x82],
  Segment: [0x18, 0x53, 0x80, 0x67],
  Info: [0x15, 0x49, 0xa9, 0x66],
  Tracks: [0x16, 0x54, 0xae, 0x6b],
  TrackEntry: [0xae],
  TrackNumber: [0xd7],
  TrackType: [0x83],
  CodecID: [0x86],
  Cluster: [0x1f, 0x43, 0xb6, 0x75],
  Void: [0xec],
};
export function ebmlHeader(docType = "webm"): Uint8Array {
  return el(ID.EBML, el(ID.DocType, bytes(docType)));
}
export function track(type: number | null, n = 1, codec = "A_OPUS"): Uint8Array {
  return el(
    ID.TrackEntry,
    el(ID.TrackNumber, bytes([n])),
    ...(type === null ? [] : [el(ID.TrackType, bytes([type]))]),
    el(ID.CodecID, bytes(codec)),
  );
}
export function webm(types: (number | null)[], opts: { docType?: string; before?: Uint8Array } = {}): Uint8Array {
  return bytes(
    ebmlHeader(opts.docType),
    elUnknown(
      ID.Segment,
      el(ID.Info, bytes([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40])),
      ...(opts.before ? [opts.before] : []),
      el(ID.Tracks, ...types.map((t, i) => track(t, i + 1, t === 1 ? "V_VP8" : "A_OPUS"))),
      elUnknown(ID.Cluster),
    ),
  );
}

const INFO = () => el(ID.Info, bytes([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]));

/** Zwei Tracks-Listen: erst nur Audio, dann Video */
export function webmTwoTrackLists(): Uint8Array {
  return bytes(
    ebmlHeader(),
    elUnknown(ID.Segment, INFO(), el(ID.Tracks, track(2)), el(ID.Tracks, track(1, 2, "V_VP8")), elUnknown(ID.Cluster)),
  );
}

/**
 * Tracks(Audio), leerer Cluster, Tracks(Video); Segment und Cluster wahlweise
 * mit bekannter oder unbekannter Größe
 */
export function webmVideoAfterEmptyCluster(opts: { knownSegment: boolean; knownCluster: boolean }): Uint8Array {
  const cluster = opts.knownCluster ? el(ID.Cluster) : elUnknown(ID.Cluster);
  const payload = bytes(INFO(), el(ID.Tracks, track(2)), cluster, el(ID.Tracks, track(1, 2, "V_VP8")));
  const segment = opts.knownSegment ? el(ID.Segment, payload) : elUnknown(ID.Segment, payload);
  return bytes(ebmlHeader(), segment);
}

/** Nur Audio, danach mehrere Cluster mit Blöcken (SimpleBlock 0xA3) */
export function webmAudioClusters(opts: { knownCluster: boolean }): Uint8Array {
  const block = el([0xa3], bytes([0x81, 0, 0, 0x80, 1, 2, 3]));
  const cluster = () => (opts.knownCluster ? el : elUnknown)(ID.Cluster, el([0xe7], bytes([0])), block, block);
  return bytes(ebmlHeader(), elUnknown(ID.Segment, INFO(), el(ID.Tracks, track(2)), cluster(), cluster()));
}

/** Eine Spur mit mehreren TrackType-Angaben in der gegebenen Reihenfolge */
export function webmTrackTypes(types: number[]): Uint8Array {
  const entry = el(
    ID.TrackEntry,
    el(ID.TrackNumber, bytes([1])),
    ...types.map(t => el(ID.TrackType, bytes([t]))),
    el(ID.CodecID, bytes("A_OPUS")),
  );
  return bytes(ebmlHeader(), elUnknown(ID.Segment, INFO(), el(ID.Tracks, entry), elUnknown(ID.Cluster)));
}

/** Audiospur mit Video-Unterelement */
export function webmAudioWithVideoElement(): Uint8Array {
  const entry = el(
    ID.TrackEntry,
    el(ID.TrackNumber, bytes([1])),
    el(ID.TrackType, bytes([2])),
    el(ID.CodecID, bytes("A_OPUS")),
    el([0xe0], el([0xb0], bytes([0x01, 0x40]))),
  );
  return bytes(ebmlHeader(), elUnknown(ID.Segment, INFO(), el(ID.Tracks, entry), elUnknown(ID.Cluster)));
}

/**
 * Segment mit bekannter Größe; ohne sizeOverride umfasst es Info und Tracks
 * vollständig, mit sizeOverride endet es früher (18: Tracks-Kopf liegt im
 * Segment, ihr Inhalt ragt hinaus; 12: Tracks liegen ganz dahinter)
 */
export function webmKnownSegment(sizeOverride?: number): Uint8Array {
  const payload = bytes(INFO(), el(ID.Tracks, track(2)));
  return bytes(ebmlHeader(), ID.Segment, ebmlSize(sizeOverride ?? payload.length), payload, elUnknown(ID.Cluster));
}
