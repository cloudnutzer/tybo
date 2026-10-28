/**
 * Ein AAC-LC-Frame aus dem Bitstrom lesen (Issue #249), ohne zu dekodieren.
 *
 * Ein AAC-Frame (raw_data_block, ISO/IEC 14496-3, Unterabschnitt 4) trägt
 * keine Längenangabe: wo er endet, ergibt sich erst aus seinen Huffman-Codes.
 * Ein MP4-Sample soll genau einen Frame enthalten, der Container zeigt aber
 * nicht, ob es so ist. Hier wird die Syntax des Frames bis zu seinem Ende
 * gelesen (Abschnitte, Skalenfaktoren, Pulse, TNS, Spektralwerte), die
 * Abtastwerte werden nicht berechnet. Damit ist der Frame eine zählbare
 * Einheit wie das Opus-Paket oder der MP3-Frame: ein Frame, 1024 Abtastwerte.
 *
 * Weitergereicht wird nicht das Sample, sondern nur sein gelesener Kanal-Teil
 * (ein Einzelkanal- oder Kanalpaar-Element), gefolgt von der Ende-Kennung.
 * Füll- und Datenelemente (SBR, Dynamik, Encoder-Vermerk) bleiben zurück:
 * ihren Inhalt liest dieser Code nicht, also soll ihn auch kein Decoder lesen.
 *
 * Eng gefasst, alles andere ist „nicht bestimmbar": nur AAC-LC mit einem oder
 * zwei Kanälen, genau ein Kanal-Element je Frame, das zur Kanalzahl passt,
 * keine Vorhersage, keine Verstärkungsregelung, keine Koppel-, LFE- oder
 * Programm-Elemente, und das Sample endet mit dem Frame.
 *
 * Ohne Importe, wie ./audio-duration.
 */

/** Abtastraten nach samplingFrequencyIndex (ISO/IEC 14496-3) */
export const AAC_SAMPLE_RATES = [96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000, 7_350];
/** Abtastwerte je Frame und Kanal bei AAC-LC mit frameLengthFlag 0 */
export const AAC_FRAME_SAMPLES = 1024;

export interface AacConfig {
  /** samplingFrequencyIndex, 0 bis 12 */
  rateIndex: number;
  /** Kanäle: 1 (Einzelkanal-Element) oder 2 (Kanalpaar-Element) */
  channels: 1 | 2;
}

// --- Tabellen aus ISO/IEC 14496-3, Unterabschnitt 4 ---

/** Grenzen der Skalenfaktorbänder im langen Fenster (1024 Werte) */
const BANDS_LONG_96 = [
  0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72, 80, 88, 96, 108, 120, 132, 144, 156, 172, 188, 212, 240, 276, 320, 384, 448, 512, 576, 640, 704, 768,
  832, 896, 960, 1024,
];
const BANDS_LONG_64 = [
  0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72, 80, 88, 100, 112, 124, 140, 156, 172, 192, 216, 240, 268, 304, 344, 384, 424, 464, 504, 544, 584, 624,
  664, 704, 744, 784, 824, 864, 904, 944, 984, 1024,
];
const BANDS_LONG_48 = [
  0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 88, 96, 108, 120, 132, 144, 160, 176, 196, 216, 240, 264, 292, 320, 352, 384, 416, 448, 480, 512, 544, 576,
  608, 640, 672, 704, 736, 768, 800, 832, 864, 896, 928, 1024,
];
const BANDS_LONG_32 = [
  0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 88, 96, 108, 120, 132, 144, 160, 176, 196, 216, 240, 264, 292, 320, 352, 384, 416, 448, 480, 512, 544, 576,
  608, 640, 672, 704, 736, 768, 800, 832, 864, 896, 928, 960, 992, 1024,
];
const BANDS_LONG_24 = [
  0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 52, 60, 68, 76, 84, 92, 100, 108, 116, 124, 136, 148, 160, 172, 188, 204, 220, 240, 260, 284, 308, 336, 364, 396, 432, 468,
  508, 552, 600, 652, 704, 768, 832, 896, 960, 1024,
];
const BANDS_LONG_16 = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 100, 112, 124, 136, 148, 160, 172, 184, 196, 212, 228, 244, 260, 280, 300, 320, 344, 368, 396, 424, 456, 492, 532, 572,
  616, 664, 716, 772, 832, 896, 960, 1024,
];
const BANDS_LONG_8 = [
  0, 12, 24, 36, 48, 60, 72, 84, 96, 108, 120, 132, 144, 156, 172, 188, 204, 220, 236, 252, 268, 288, 308, 328, 348, 372, 396, 420, 448, 476, 508, 544, 580, 620, 664,
  712, 764, 820, 880, 944, 1024,
];
/** Grenzen der Skalenfaktorbänder im kurzen Fenster (128 Werte) */
const BANDS_SHORT_96 = [0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 92, 128];
const BANDS_SHORT_48 = [0, 4, 8, 12, 16, 20, 28, 36, 44, 56, 68, 80, 96, 112, 128];
const BANDS_SHORT_24 = [0, 4, 8, 12, 16, 20, 24, 28, 36, 44, 52, 64, 76, 92, 108, 128];
const BANDS_SHORT_16 = [0, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 60, 72, 88, 108, 128];
const BANDS_SHORT_8 = [0, 4, 8, 12, 16, 20, 24, 28, 36, 44, 52, 60, 72, 88, 108, 128];

/** Je samplingFrequencyIndex: 96, 88,2, 64, 48, 44,1, 32, 24, 22,05, 16, 12, 11,025, 8 und 7,35 kHz */
const BANDS_LONG = [
  BANDS_LONG_96, BANDS_LONG_96, BANDS_LONG_64, BANDS_LONG_48, BANDS_LONG_48, BANDS_LONG_32, BANDS_LONG_24, BANDS_LONG_24, BANDS_LONG_16, BANDS_LONG_16, BANDS_LONG_16,
  BANDS_LONG_8, BANDS_LONG_8,
];
const BANDS_SHORT = [
  BANDS_SHORT_96, BANDS_SHORT_96, BANDS_SHORT_96, BANDS_SHORT_48, BANDS_SHORT_48, BANDS_SHORT_48, BANDS_SHORT_24, BANDS_SHORT_24, BANDS_SHORT_16, BANDS_SHORT_16,
  BANDS_SHORT_16, BANDS_SHORT_8, BANDS_SHORT_8,
];

/** Huffman-Codebuch der Skalenfaktoren: je Index die Länge in Bit und das Codewort */
const SCALEFACTOR_BITS = [
  18, 18, 18, 18, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 18, 19, 18, 17, 17, 16, 17, 16, 16, 16, 16, 15, 15,
  14, 14, 14, 14, 14, 14, 13, 13, 12, 12, 12, 11, 12, 11, 10, 10, 10, 9, 9, 8, 8, 8, 7, 6, 6, 5, 4, 3, 1, 4, 4, 5,
  6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 10, 11, 11, 11, 11, 12, 12, 13, 13, 13, 14, 14, 16, 15, 16, 15, 18, 19, 19, 19, 19, 19,
  19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19,
];

const SCALEFACTOR_CODES = [
  0x3ffe8, 0x3ffe6, 0x3ffe7, 0x3ffe5, 0x7fff5, 0x7fff1, 0x7ffed, 0x7fff6, 0x7ffee, 0x7ffef, 0x7fff0, 0x7fffc, 0x7fffd, 0x7ffff, 0x7fffe, 0x7fff7,
  0x7fff8, 0x7fffb, 0x7fff9, 0x3ffe4, 0x7fffa, 0x3ffe3, 0x1ffef, 0x1fff0, 0x0fff5, 0x1ffee, 0x0fff2, 0x0fff3, 0x0fff4, 0x0fff1, 0x07ff6, 0x07ff7,
  0x03ff9, 0x03ff5, 0x03ff7, 0x03ff3, 0x03ff6, 0x03ff2, 0x01ff7, 0x01ff5, 0x00ff9, 0x00ff7, 0x00ff6, 0x007f9, 0x00ff4, 0x007f8, 0x003f9, 0x003f7,
  0x003f5, 0x001f8, 0x001f7, 0x000fa, 0x000f8, 0x000f6, 0x00079, 0x0003a, 0x00038, 0x0001a, 0x0000b, 0x00004, 0x00000, 0x0000a, 0x0000c, 0x0001b,
  0x00039, 0x0003b, 0x00078, 0x0007a, 0x000f7, 0x000f9, 0x001f6, 0x001f9, 0x003f4, 0x003f6, 0x003f8, 0x007f5, 0x007f4, 0x007f6, 0x007f7, 0x00ff5,
  0x00ff8, 0x01ff4, 0x01ff6, 0x01ff8, 0x03ff8, 0x03ff4, 0x0fff0, 0x07ff4, 0x0fff6, 0x07ff5, 0x3ffe2, 0x7ffd9, 0x7ffda, 0x7ffdb, 0x7ffdc, 0x7ffdd,
  0x7ffde, 0x7ffd8, 0x7ffd2, 0x7ffd3, 0x7ffd4, 0x7ffd5, 0x7ffd6, 0x7fff2, 0x7ffdf, 0x7ffe7, 0x7ffe8, 0x7ffe9, 0x7ffea, 0x7ffeb, 0x7ffe6, 0x7ffe0,
  0x7ffe1, 0x7ffe2, 0x7ffe3, 0x7ffe4, 0x7ffe5, 0x7ffd7, 0x7ffec, 0x7fff4, 0x7fff3,
];

/** Huffman-Codebücher 1 bis 11 der Spektralwerte: je Index die Länge in Bit und das Codewort */
const SPECTRAL_BITS = [
  [
    11, 9, 11, 10, 7, 10, 11, 9, 11, 10, 7, 10, 7, 5, 7, 9, 7, 10, 11, 9, 11, 9, 7, 9, 11, 9, 11, 9, 7, 9, 7, 5,
    7, 9, 7, 9, 7, 5, 7, 5, 1, 5, 7, 5, 7, 9, 7, 9, 7, 5, 7, 9, 7, 9, 11, 9, 11, 9, 7, 9, 11, 9, 11, 10,
    7, 9, 7, 5, 7, 9, 7, 10, 11, 9, 11, 10, 7, 9, 11, 9, 11,
  ],
  [
    9, 7, 9, 8, 6, 8, 9, 8, 9, 8, 6, 7, 6, 5, 6, 7, 6, 8, 9, 7, 8, 8, 6, 8, 9, 7, 9, 8, 6, 7, 6, 5,
    6, 7, 6, 8, 6, 5, 6, 5, 3, 5, 6, 5, 6, 8, 6, 7, 6, 5, 6, 8, 6, 8, 9, 7, 9, 8, 6, 8, 8, 7, 9, 8,
    6, 7, 6, 4, 6, 8, 6, 7, 9, 7, 9, 7, 6, 8, 9, 7, 9,
  ],
  [
    1, 4, 8, 4, 5, 8, 9, 9, 10, 4, 6, 9, 6, 6, 9, 9, 9, 10, 9, 10, 13, 9, 9, 11, 11, 10, 12, 4, 6, 10, 6, 7,
    10, 10, 10, 12, 5, 7, 11, 6, 7, 10, 9, 9, 11, 9, 10, 13, 8, 9, 12, 10, 11, 12, 8, 10, 15, 9, 11, 15, 13, 14, 16, 8,
    10, 14, 9, 10, 14, 12, 12, 15, 11, 12, 16, 10, 11, 15, 12, 12, 15,
  ],
  [
    4, 5, 8, 5, 4, 8, 9, 8, 11, 5, 5, 8, 5, 4, 8, 8, 7, 10, 9, 8, 11, 8, 8, 10, 11, 10, 11, 4, 5, 8, 4, 4,
    8, 8, 8, 10, 4, 4, 8, 4, 4, 7, 8, 7, 9, 8, 8, 10, 7, 7, 9, 10, 9, 10, 8, 8, 11, 8, 7, 10, 11, 10, 12, 8,
    7, 10, 7, 7, 9, 10, 9, 11, 11, 10, 12, 10, 9, 11, 11, 10, 11,
  ],
  [
    13, 12, 11, 11, 10, 11, 11, 12, 13, 12, 11, 10, 9, 8, 9, 10, 11, 12, 12, 10, 9, 8, 7, 8, 9, 10, 11, 11, 9, 8, 5, 4,
    5, 8, 9, 11, 10, 8, 7, 4, 1, 4, 7, 8, 11, 11, 9, 8, 5, 4, 5, 8, 9, 11, 11, 10, 9, 8, 7, 8, 9, 10, 11, 12,
    11, 10, 9, 8, 9, 10, 11, 12, 13, 12, 12, 11, 10, 10, 11, 12, 13,
  ],
  [
    11, 10, 9, 9, 9, 9, 9, 10, 11, 10, 9, 8, 7, 7, 7, 8, 9, 10, 9, 8, 6, 6, 6, 6, 6, 8, 9, 9, 7, 6, 4, 4,
    4, 6, 7, 9, 9, 7, 6, 4, 4, 4, 6, 7, 9, 9, 7, 6, 4, 4, 4, 6, 7, 9, 9, 8, 6, 6, 6, 6, 6, 8, 9, 10,
    9, 8, 7, 7, 7, 7, 8, 10, 11, 10, 9, 9, 9, 9, 9, 10, 11,
  ],
  [
    1, 3, 6, 7, 8, 9, 10, 11, 3, 4, 6, 7, 8, 8, 9, 9, 6, 6, 7, 8, 8, 9, 9, 10, 7, 7, 8, 8, 9, 9, 10, 10,
    8, 8, 9, 9, 10, 10, 10, 11, 9, 8, 9, 9, 10, 10, 11, 11, 10, 9, 9, 10, 10, 11, 12, 12, 11, 10, 10, 10, 11, 11, 12, 12,
  ],
  [
    5, 4, 5, 6, 7, 8, 9, 10, 4, 3, 4, 5, 6, 7, 7, 8, 5, 4, 4, 5, 6, 7, 7, 8, 6, 5, 5, 6, 6, 7, 8, 8,
    7, 6, 6, 6, 7, 7, 8, 9, 8, 7, 6, 7, 7, 8, 8, 10, 9, 7, 7, 8, 8, 8, 9, 9, 10, 8, 8, 8, 9, 9, 9, 10,
  ],
  [
    1, 3, 6, 8, 9, 10, 10, 11, 11, 12, 12, 13, 13, 3, 4, 6, 7, 8, 8, 9, 10, 10, 10, 11, 12, 12, 6, 6, 7, 8, 8, 9,
    10, 10, 10, 11, 12, 12, 12, 8, 7, 8, 9, 9, 10, 10, 11, 11, 11, 12, 12, 13, 9, 8, 9, 9, 10, 10, 11, 11, 11, 12, 12, 12,
    13, 10, 9, 9, 10, 11, 11, 11, 12, 11, 12, 12, 13, 13, 11, 9, 10, 11, 11, 11, 12, 12, 12, 12, 13, 13, 13, 11, 10, 10, 11, 11,
    12, 12, 13, 13, 13, 13, 13, 13, 11, 10, 10, 11, 11, 11, 12, 12, 13, 13, 14, 13, 14, 11, 10, 11, 11, 12, 12, 12, 12, 13, 13, 14,
    14, 14, 12, 11, 11, 12, 12, 12, 13, 13, 13, 14, 14, 14, 15, 12, 11, 12, 12, 12, 13, 13, 13, 13, 14, 14, 15, 15, 13, 12, 12, 12,
    13, 13, 13, 13, 14, 14, 14, 14, 15,
  ],
  [
    6, 5, 6, 6, 7, 8, 9, 10, 10, 10, 11, 11, 12, 5, 4, 4, 5, 6, 7, 7, 8, 8, 9, 10, 10, 11, 6, 4, 5, 5, 6, 6,
    7, 8, 8, 9, 9, 10, 10, 6, 5, 5, 5, 6, 7, 7, 8, 8, 9, 9, 10, 10, 7, 6, 6, 6, 6, 7, 7, 8, 8, 9, 9, 10,
    10, 8, 7, 6, 7, 7, 7, 8, 8, 8, 9, 10, 10, 11, 9, 7, 7, 7, 7, 8, 8, 9, 9, 9, 10, 10, 11, 9, 8, 8, 8, 8,
    8, 9, 9, 9, 10, 10, 11, 11, 9, 8, 8, 8, 8, 8, 9, 9, 10, 10, 10, 11, 11, 10, 9, 9, 9, 9, 9, 9, 10, 10, 10, 11,
    11, 12, 10, 9, 9, 9, 9, 10, 10, 10, 10, 11, 11, 11, 12, 11, 10, 9, 10, 10, 10, 10, 10, 11, 11, 11, 11, 12, 11, 10, 10, 10,
    10, 10, 10, 11, 11, 12, 12, 12, 12,
  ],
  [
    4, 5, 6, 7, 8, 8, 9, 10, 10, 10, 11, 11, 12, 11, 12, 12, 10, 5, 4, 5, 6, 7, 7, 8, 8, 9, 9, 9, 10, 10, 10, 10,
    11, 8, 6, 5, 5, 6, 7, 7, 8, 8, 8, 9, 9, 9, 10, 10, 10, 10, 8, 7, 6, 6, 6, 7, 7, 8, 8, 8, 9, 9, 9, 10,
    10, 10, 10, 8, 8, 7, 7, 7, 7, 8, 8, 8, 8, 9, 9, 9, 10, 10, 10, 10, 8, 8, 7, 7, 7, 7, 8, 8, 8, 9, 9, 9,
    9, 10, 10, 10, 10, 8, 9, 8, 8, 8, 8, 8, 8, 8, 9, 9, 9, 10, 10, 10, 10, 10, 8, 9, 8, 8, 8, 8, 8, 8, 9, 9,
    9, 10, 10, 10, 10, 10, 10, 8, 10, 9, 8, 8, 9, 9, 9, 9, 9, 10, 10, 10, 10, 10, 10, 11, 8, 10, 9, 9, 9, 9, 9, 9,
    9, 10, 10, 10, 10, 10, 10, 11, 11, 8, 11, 9, 9, 9, 9, 9, 9, 10, 10, 10, 10, 10, 11, 10, 11, 11, 8, 11, 10, 9, 9, 10,
    9, 10, 10, 10, 10, 10, 11, 11, 11, 11, 11, 8, 11, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 11, 11, 11, 11, 11, 9, 11, 10, 9,
    9, 10, 10, 10, 10, 10, 10, 11, 11, 11, 11, 11, 11, 9, 11, 10, 10, 10, 10, 10, 10, 10, 10, 10, 11, 11, 11, 11, 11, 11, 9, 12,
    10, 10, 10, 10, 10, 10, 10, 11, 11, 11, 11, 11, 11, 12, 12, 9, 9, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 9,
    5,
  ],
];

const SPECTRAL_CODES = [
  [
    0x07f8, 0x01f1, 0x07fd, 0x03f5, 0x0068, 0x03f0, 0x07f7, 0x01ec, 0x07f5, 0x03f1, 0x0072, 0x03f4, 0x0074, 0x0011, 0x0076, 0x01eb,
    0x006c, 0x03f6, 0x07fc, 0x01e1, 0x07f1, 0x01f0, 0x0061, 0x01f6, 0x07f2, 0x01ea, 0x07fb, 0x01f2, 0x0069, 0x01ed, 0x0077, 0x0017,
    0x006f, 0x01e6, 0x0064, 0x01e5, 0x0067, 0x0015, 0x0062, 0x0012, 0x0000, 0x0014, 0x0065, 0x0016, 0x006d, 0x01e9, 0x0063, 0x01e4,
    0x006b, 0x0013, 0x0071, 0x01e3, 0x0070, 0x01f3, 0x07fe, 0x01e7, 0x07f3, 0x01ef, 0x0060, 0x01ee, 0x07f0, 0x01e2, 0x07fa, 0x03f3,
    0x006a, 0x01e8, 0x0075, 0x0010, 0x0073, 0x01f4, 0x006e, 0x03f7, 0x07f6, 0x01e0, 0x07f9, 0x03f2, 0x0066, 0x01f5, 0x07ff, 0x01f7,
    0x07f4,
  ],
  [
    0x01f3, 0x006f, 0x01fd, 0x00eb, 0x0023, 0x00ea, 0x01f7, 0x00e8, 0x01fa, 0x00f2, 0x002d, 0x0070, 0x0020, 0x0006, 0x002b, 0x006e,
    0x0028, 0x00e9, 0x01f9, 0x0066, 0x00f8, 0x00e7, 0x001b, 0x00f1, 0x01f4, 0x006b, 0x01f5, 0x00ec, 0x002a, 0x006c, 0x002c, 0x000a,
    0x0027, 0x0067, 0x001a, 0x00f5, 0x0024, 0x0008, 0x001f, 0x0009, 0x0000, 0x0007, 0x001d, 0x000b, 0x0030, 0x00ef, 0x001c, 0x0064,
    0x001e, 0x000c, 0x0029, 0x00f3, 0x002f, 0x00f0, 0x01fc, 0x0071, 0x01f2, 0x00f4, 0x0021, 0x00e6, 0x00f7, 0x0068, 0x01f8, 0x00ee,
    0x0022, 0x0065, 0x0031, 0x0002, 0x0026, 0x00ed, 0x0025, 0x006a, 0x01fb, 0x0072, 0x01fe, 0x0069, 0x002e, 0x00f6, 0x01ff, 0x006d,
    0x01f6,
  ],
  [
    0x0000, 0x0009, 0x00ef, 0x000b, 0x0019, 0x00f0, 0x01eb, 0x01e6, 0x03f2, 0x000a, 0x0035, 0x01ef, 0x0034, 0x0037, 0x01e9, 0x01ed,
    0x01e7, 0x03f3, 0x01ee, 0x03ed, 0x1ffa, 0x01ec, 0x01f2, 0x07f9, 0x07f8, 0x03f8, 0x0ff8, 0x0008, 0x0038, 0x03f6, 0x0036, 0x0075,
    0x03f1, 0x03eb, 0x03ec, 0x0ff4, 0x0018, 0x0076, 0x07f4, 0x0039, 0x0074, 0x03ef, 0x01f3, 0x01f4, 0x07f6, 0x01e8, 0x03ea, 0x1ffc,
    0x00f2, 0x01f1, 0x0ffb, 0x03f5, 0x07f3, 0x0ffc, 0x00ee, 0x03f7, 0x7ffe, 0x01f0, 0x07f5, 0x7ffd, 0x1ffb, 0x3ffa, 0xffff, 0x00f1,
    0x03f0, 0x3ffc, 0x01ea, 0x03ee, 0x3ffb, 0x0ff6, 0x0ffa, 0x7ffc, 0x07f2, 0x0ff5, 0xfffe, 0x03f4, 0x07f7, 0x7ffb, 0x0ff7, 0x0ff9,
    0x7ffa,
  ],
  [
    0x0007, 0x0016, 0x00f6, 0x0018, 0x0008, 0x00ef, 0x01ef, 0x00f3, 0x07f8, 0x0019, 0x0017, 0x00ed, 0x0015, 0x0001, 0x00e2, 0x00f0,
    0x0070, 0x03f0, 0x01ee, 0x00f1, 0x07fa, 0x00ee, 0x00e4, 0x03f2, 0x07f6, 0x03ef, 0x07fd, 0x0005, 0x0014, 0x00f2, 0x0009, 0x0004,
    0x00e5, 0x00f4, 0x00e8, 0x03f4, 0x0006, 0x0002, 0x00e7, 0x0003, 0x0000, 0x006b, 0x00e3, 0x0069, 0x01f3, 0x00eb, 0x00e6, 0x03f6,
    0x006e, 0x006a, 0x01f4, 0x03ec, 0x01f0, 0x03f9, 0x00f5, 0x00ec, 0x07fb, 0x00ea, 0x006f, 0x03f7, 0x07f9, 0x03f3, 0x0fff, 0x00e9,
    0x006d, 0x03f8, 0x006c, 0x0068, 0x01f5, 0x03ee, 0x01f2, 0x07f4, 0x07f7, 0x03f1, 0x0ffe, 0x03ed, 0x01f1, 0x07f5, 0x07fe, 0x03f5,
    0x07fc,
  ],
  [
    0x1fff, 0x0ff7, 0x07f4, 0x07e8, 0x03f1, 0x07ee, 0x07f9, 0x0ff8, 0x1ffd, 0x0ffd, 0x07f1, 0x03e8, 0x01e8, 0x00f0, 0x01ec, 0x03ee,
    0x07f2, 0x0ffa, 0x0ff4, 0x03ef, 0x01f2, 0x00e8, 0x0070, 0x00ec, 0x01f0, 0x03ea, 0x07f3, 0x07eb, 0x01eb, 0x00ea, 0x001a, 0x0008,
    0x0019, 0x00ee, 0x01ef, 0x07ed, 0x03f0, 0x00f2, 0x0073, 0x000b, 0x0000, 0x000a, 0x0071, 0x00f3, 0x07e9, 0x07ef, 0x01ee, 0x00ef,
    0x0018, 0x0009, 0x001b, 0x00eb, 0x01e9, 0x07ec, 0x07f6, 0x03eb, 0x01f3, 0x00ed, 0x0072, 0x00e9, 0x01f1, 0x03ed, 0x07f7, 0x0ff6,
    0x07f0, 0x03e9, 0x01ed, 0x00f1, 0x01ea, 0x03ec, 0x07f8, 0x0ff9, 0x1ffc, 0x0ffc, 0x0ff5, 0x07ea, 0x03f3, 0x03f2, 0x07f5, 0x0ffb,
    0x1ffe,
  ],
  [
    0x07fe, 0x03fd, 0x01f1, 0x01eb, 0x01f4, 0x01ea, 0x01f0, 0x03fc, 0x07fd, 0x03f6, 0x01e5, 0x00ea, 0x006c, 0x0071, 0x0068, 0x00f0,
    0x01e6, 0x03f7, 0x01f3, 0x00ef, 0x0032, 0x0027, 0x0028, 0x0026, 0x0031, 0x00eb, 0x01f7, 0x01e8, 0x006f, 0x002e, 0x0008, 0x0004,
    0x0006, 0x0029, 0x006b, 0x01ee, 0x01ef, 0x0072, 0x002d, 0x0002, 0x0000, 0x0003, 0x002f, 0x0073, 0x01fa, 0x01e7, 0x006e, 0x002b,
    0x0007, 0x0001, 0x0005, 0x002c, 0x006d, 0x01ec, 0x01f9, 0x00ee, 0x0030, 0x0024, 0x002a, 0x0025, 0x0033, 0x00ec, 0x01f2, 0x03f8,
    0x01e4, 0x00ed, 0x006a, 0x0070, 0x0069, 0x0074, 0x00f1, 0x03fa, 0x07ff, 0x03f9, 0x01f6, 0x01ed, 0x01f8, 0x01e9, 0x01f5, 0x03fb,
    0x07fc,
  ],
  [
    0x0000, 0x0005, 0x0037, 0x0074, 0x00f2, 0x01eb, 0x03ed, 0x07f7, 0x0004, 0x000c, 0x0035, 0x0071, 0x00ec, 0x00ee, 0x01ee, 0x01f5,
    0x0036, 0x0034, 0x0072, 0x00ea, 0x00f1, 0x01e9, 0x01f3, 0x03f5, 0x0073, 0x0070, 0x00eb, 0x00f0, 0x01f1, 0x01f0, 0x03ec, 0x03fa,
    0x00f3, 0x00ed, 0x01e8, 0x01ef, 0x03ef, 0x03f1, 0x03f9, 0x07fb, 0x01ed, 0x00ef, 0x01ea, 0x01f2, 0x03f3, 0x03f8, 0x07f9, 0x07fc,
    0x03ee, 0x01ec, 0x01f4, 0x03f4, 0x03f7, 0x07f8, 0x0ffd, 0x0ffe, 0x07f6, 0x03f0, 0x03f2, 0x03f6, 0x07fa, 0x07fd, 0x0ffc, 0x0fff,
  ],
  [
    0x000e, 0x0005, 0x0010, 0x0030, 0x006f, 0x00f1, 0x01fa, 0x03fe, 0x0003, 0x0000, 0x0004, 0x0012, 0x002c, 0x006a, 0x0075, 0x00f8,
    0x000f, 0x0002, 0x0006, 0x0014, 0x002e, 0x0069, 0x0072, 0x00f5, 0x002f, 0x0011, 0x0013, 0x002a, 0x0032, 0x006c, 0x00ec, 0x00fa,
    0x0071, 0x002b, 0x002d, 0x0031, 0x006d, 0x0070, 0x00f2, 0x01f9, 0x00ef, 0x0068, 0x0033, 0x006b, 0x006e, 0x00ee, 0x00f9, 0x03fc,
    0x01f8, 0x0074, 0x0073, 0x00ed, 0x00f0, 0x00f6, 0x01f6, 0x01fd, 0x03fd, 0x00f3, 0x00f4, 0x00f7, 0x01f7, 0x01fb, 0x01fc, 0x03ff,
  ],
  [
    0x0000, 0x0005, 0x0037, 0x00e7, 0x01de, 0x03ce, 0x03d9, 0x07c8, 0x07cd, 0x0fc8, 0x0fdd, 0x1fe4, 0x1fec, 0x0004, 0x000c, 0x0035,
    0x0072, 0x00ea, 0x00ed, 0x01e2, 0x03d1, 0x03d3, 0x03e0, 0x07d8, 0x0fcf, 0x0fd5, 0x0036, 0x0034, 0x0071, 0x00e8, 0x00ec, 0x01e1,
    0x03cf, 0x03dd, 0x03db, 0x07d0, 0x0fc7, 0x0fd4, 0x0fe4, 0x00e6, 0x0070, 0x00e9, 0x01dd, 0x01e3, 0x03d2, 0x03dc, 0x07cc, 0x07ca,
    0x07de, 0x0fd8, 0x0fea, 0x1fdb, 0x01df, 0x00eb, 0x01dc, 0x01e6, 0x03d5, 0x03de, 0x07cb, 0x07dd, 0x07dc, 0x0fcd, 0x0fe2, 0x0fe7,
    0x1fe1, 0x03d0, 0x01e0, 0x01e4, 0x03d6, 0x07c5, 0x07d1, 0x07db, 0x0fd2, 0x07e0, 0x0fd9, 0x0feb, 0x1fe3, 0x1fe9, 0x07c4, 0x01e5,
    0x03d7, 0x07c6, 0x07cf, 0x07da, 0x0fcb, 0x0fda, 0x0fe3, 0x0fe9, 0x1fe6, 0x1ff3, 0x1ff7, 0x07d3, 0x03d8, 0x03e1, 0x07d4, 0x07d9,
    0x0fd3, 0x0fde, 0x1fdd, 0x1fd9, 0x1fe2, 0x1fea, 0x1ff1, 0x1ff6, 0x07d2, 0x03d4, 0x03da, 0x07c7, 0x07d7, 0x07e2, 0x0fce, 0x0fdb,
    0x1fd8, 0x1fee, 0x3ff0, 0x1ff4, 0x3ff2, 0x07e1, 0x03df, 0x07c9, 0x07d6, 0x0fca, 0x0fd0, 0x0fe5, 0x0fe6, 0x1feb, 0x1fef, 0x3ff3,
    0x3ff4, 0x3ff5, 0x0fe0, 0x07ce, 0x07d5, 0x0fc6, 0x0fd1, 0x0fe1, 0x1fe0, 0x1fe8, 0x1ff0, 0x3ff1, 0x3ff8, 0x3ff6, 0x7ffc, 0x0fe8,
    0x07df, 0x0fc9, 0x0fd7, 0x0fdc, 0x1fdc, 0x1fdf, 0x1fed, 0x1ff5, 0x3ff9, 0x3ffb, 0x7ffd, 0x7ffe, 0x1fe7, 0x0fcc, 0x0fd6, 0x0fdf,
    0x1fde, 0x1fda, 0x1fe5, 0x1ff2, 0x3ffa, 0x3ff7, 0x3ffc, 0x3ffd, 0x7fff,
  ],
  [
    0x0022, 0x0008, 0x001d, 0x0026, 0x005f, 0x00d3, 0x01cf, 0x03d0, 0x03d7, 0x03ed, 0x07f0, 0x07f6, 0x0ffd, 0x0007, 0x0000, 0x0001,
    0x0009, 0x0020, 0x0054, 0x0060, 0x00d5, 0x00dc, 0x01d4, 0x03cd, 0x03de, 0x07e7, 0x001c, 0x0002, 0x0006, 0x000c, 0x001e, 0x0028,
    0x005b, 0x00cd, 0x00d9, 0x01ce, 0x01dc, 0x03d9, 0x03f1, 0x0025, 0x000b, 0x000a, 0x000d, 0x0024, 0x0057, 0x0061, 0x00cc, 0x00dd,
    0x01cc, 0x01de, 0x03d3, 0x03e7, 0x005d, 0x0021, 0x001f, 0x0023, 0x0027, 0x0059, 0x0064, 0x00d8, 0x00df, 0x01d2, 0x01e2, 0x03dd,
    0x03ee, 0x00d1, 0x0055, 0x0029, 0x0056, 0x0058, 0x0062, 0x00ce, 0x00e0, 0x00e2, 0x01da, 0x03d4, 0x03e3, 0x07eb, 0x01c9, 0x005e,
    0x005a, 0x005c, 0x0063, 0x00ca, 0x00da, 0x01c7, 0x01ca, 0x01e0, 0x03db, 0x03e8, 0x07ec, 0x01e3, 0x00d2, 0x00cb, 0x00d0, 0x00d7,
    0x00db, 0x01c6, 0x01d5, 0x01d8, 0x03ca, 0x03da, 0x07ea, 0x07f1, 0x01e1, 0x00d4, 0x00cf, 0x00d6, 0x00de, 0x00e1, 0x01d0, 0x01d6,
    0x03d1, 0x03d5, 0x03f2, 0x07ee, 0x07fb, 0x03e9, 0x01cd, 0x01c8, 0x01cb, 0x01d1, 0x01d7, 0x01df, 0x03cf, 0x03e0, 0x03ef, 0x07e6,
    0x07f8, 0x0ffa, 0x03eb, 0x01dd, 0x01d3, 0x01d9, 0x01db, 0x03d2, 0x03cc, 0x03dc, 0x03ea, 0x07ed, 0x07f3, 0x07f9, 0x0ff9, 0x07f2,
    0x03ce, 0x01e4, 0x03cb, 0x03d8, 0x03d6, 0x03e2, 0x03e5, 0x07e8, 0x07f4, 0x07f5, 0x07f7, 0x0ffb, 0x07fa, 0x03ec, 0x03df, 0x03e1,
    0x03e4, 0x03e6, 0x03f0, 0x07e9, 0x07ef, 0x0ff8, 0x0ffe, 0x0ffc, 0x0fff,
  ],
  [
    0x0000, 0x0006, 0x0019, 0x003d, 0x009c, 0x00c6, 0x01a7, 0x0390, 0x03c2, 0x03df, 0x07e6, 0x07f3, 0x0ffb, 0x07ec, 0x0ffa, 0x0ffe,
    0x038e, 0x0005, 0x0001, 0x0008, 0x0014, 0x0037, 0x0042, 0x0092, 0x00af, 0x0191, 0x01a5, 0x01b5, 0x039e, 0x03c0, 0x03a2, 0x03cd,
    0x07d6, 0x00ae, 0x0017, 0x0007, 0x0009, 0x0018, 0x0039, 0x0040, 0x008e, 0x00a3, 0x00b8, 0x0199, 0x01ac, 0x01c1, 0x03b1, 0x0396,
    0x03be, 0x03ca, 0x009d, 0x003c, 0x0015, 0x0016, 0x001a, 0x003b, 0x0044, 0x0091, 0x00a5, 0x00be, 0x0196, 0x01ae, 0x01b9, 0x03a1,
    0x0391, 0x03a5, 0x03d5, 0x0094, 0x009a, 0x0036, 0x0038, 0x003a, 0x0041, 0x008c, 0x009b, 0x00b0, 0x00c3, 0x019e, 0x01ab, 0x01bc,
    0x039f, 0x038f, 0x03a9, 0x03cf, 0x0093, 0x00bf, 0x003e, 0x003f, 0x0043, 0x0045, 0x009e, 0x00a7, 0x00b9, 0x0194, 0x01a2, 0x01ba,
    0x01c3, 0x03a6, 0x03a7, 0x03bb, 0x03d4, 0x009f, 0x01a0, 0x008f, 0x008d, 0x0090, 0x0098, 0x00a6, 0x00b6, 0x00c4, 0x019f, 0x01af,
    0x01bf, 0x0399, 0x03bf, 0x03b4, 0x03c9, 0x03e7, 0x00a8, 0x01b6, 0x00ab, 0x00a4, 0x00aa, 0x00b2, 0x00c2, 0x00c5, 0x0198, 0x01a4,
    0x01b8, 0x038c, 0x03a4, 0x03c4, 0x03c6, 0x03dd, 0x03e8, 0x00ad, 0x03af, 0x0192, 0x00bd, 0x00bc, 0x018e, 0x0197, 0x019a, 0x01a3,
    0x01b1, 0x038d, 0x0398, 0x03b7, 0x03d3, 0x03d1, 0x03db, 0x07dd, 0x00b4, 0x03de, 0x01a9, 0x019b, 0x019c, 0x01a1, 0x01aa, 0x01ad,
    0x01b3, 0x038b, 0x03b2, 0x03b8, 0x03ce, 0x03e1, 0x03e0, 0x07d2, 0x07e5, 0x00b7, 0x07e3, 0x01bb, 0x01a8, 0x01a6, 0x01b0, 0x01b2,
    0x01b7, 0x039b, 0x039a, 0x03ba, 0x03b5, 0x03d6, 0x07d7, 0x03e4, 0x07d8, 0x07ea, 0x00ba, 0x07e8, 0x03a0, 0x01bd, 0x01b4, 0x038a,
    0x01c4, 0x0392, 0x03aa, 0x03b0, 0x03bc, 0x03d7, 0x07d4, 0x07dc, 0x07db, 0x07d5, 0x07f0, 0x00c1, 0x07fb, 0x03c8, 0x03a3, 0x0395,
    0x039d, 0x03ac, 0x03ae, 0x03c5, 0x03d8, 0x03e2, 0x03e6, 0x07e4, 0x07e7, 0x07e0, 0x07e9, 0x07f7, 0x0190, 0x07f2, 0x0393, 0x01be,
    0x01c0, 0x0394, 0x0397, 0x03ad, 0x03c3, 0x03c1, 0x03d2, 0x07da, 0x07d9, 0x07df, 0x07eb, 0x07f4, 0x07fa, 0x0195, 0x07f8, 0x03bd,
    0x039c, 0x03ab, 0x03a8, 0x03b3, 0x03b9, 0x03d0, 0x03e3, 0x03e5, 0x07e2, 0x07de, 0x07ed, 0x07f1, 0x07f9, 0x07fc, 0x0193, 0x0ffd,
    0x03dc, 0x03b6, 0x03c7, 0x03cc, 0x03cb, 0x03d9, 0x03da, 0x07d3, 0x07e1, 0x07ee, 0x07ef, 0x07f5, 0x07f6, 0x0ffc, 0x0fff, 0x019d,
    0x01c2, 0x00b5, 0x00a1, 0x0096, 0x0097, 0x0095, 0x0099, 0x00a0, 0x00a2, 0x00ac, 0x00a9, 0x00b1, 0x00b3, 0x00bb, 0x00c0, 0x018f,
    0x0004,
  ],
];

// --- Lesen ---

/** Geworfen, sobald der Frame nicht zur erlaubten Syntax passt oder über sein Sample hinausläuft */
const INVALID = new Error("kein einzelner AAC-LC-Frame");

/**
 * Huffman-Baum aus Längen und Codewörtern: je Knoten zwei Einträge (Bit 0,
 * Bit 1). Größer 0: nächster Knoten, kleiner 0: Blatt mit Index ~Wert. Die
 * Codebücher sind vollständig: jede Bitfolge endet in einem Blatt.
 */
function huffmanTree(bits: number[], codes: number[]): Int16Array {
  const tree = [0, 0];
  for (let index = 0; index < bits.length; index++) {
    let node = 0;
    for (let i = bits[index] - 1; i >= 0; i--) {
      const at = node * 2 + ((codes[index] >>> i) & 1);
      if (i === 0) tree[at] = ~index;
      else {
        if (!tree[at]) {
          tree[at] = tree.length / 2;
          tree.push(0, 0);
        }
        node = tree[at];
      }
    }
  }
  // Ein Tippfehler in einer Tabelle ließe eine Bitfolge ohne Blatt: dann lieber gar nicht laden
  if (tree.includes(0)) throw new Error("Huffman-Codebuch unvollständig");
  return Int16Array.from(tree);
}

const SCALEFACTOR_TREE = huffmanTree(SCALEFACTOR_BITS, SCALEFACTOR_CODES);
const SPECTRAL_TREES = SPECTRAL_BITS.map((bits, i) => huffmanTree(bits, SPECTRAL_CODES[i]));

/** Codebücher ohne Vorzeichen: je Wert ungleich 0 folgt ein Vorzeichen-Bit */
const UNSIGNED_BOOKS = new Set([3, 4, 7, 8, 9, 10, 11]);
/** Größter Betrag je Codebuch ohne Vorzeichen: der Index ist die Zahl aus den Werten zur Basis Betrag plus 1 */
const LARGEST = [0, 0, 0, 2, 2, 0, 0, 7, 7, 12, 12, 16];
/** Im Codebuch 11 steht 16 für „Wert folgt als Escape-Folge" */
const ESCAPE_BOOK = 11;
const ESCAPE_VALUE = 16;

/**
 * Je Codebuch und Index: wie viele Bits nach dem Codewort folgen, bevor das
 * nächste beginnt. Untere 3 Bit: Vorzeichen-Bits (Werte ungleich 0), darüber
 * die Zahl der Escape-Folgen (Werte 16 im Codebuch 11).
 */
const SPECTRAL_EXTRA = SPECTRAL_BITS.map((bits, i) => {
  const book = i + 1;
  const extra = new Uint8Array(bits.length);
  if (!UNSIGNED_BOOKS.has(book)) return extra;
  const base = LARGEST[book] + 1;
  for (let index = 0; index < bits.length; index++) {
    let signs = 0;
    let escapes = 0;
    for (let rest = index, n = book < 5 ? 4 : 2; n > 0; n--, rest = Math.floor(rest / base)) {
      const value = rest % base;
      if (value) signs++;
      if (book === ESCAPE_BOOK && value === ESCAPE_VALUE) escapes++;
    }
    extra[index] = signs | (escapes << 3);
  }
  return extra;
});

/** Bits von vorn nach hinten, bis zum Ende des Samples */
class BitReader {
  /** Position in Bit ab Anfang der Datei */
  pos: number;
  private readonly end: number;

  constructor(
    private readonly b: Uint8Array,
    start: number,
    size: number
  ) {
    this.pos = start * 8;
    this.end = (start + size) * 8;
  }

  bit(): number {
    if (this.pos >= this.end) throw INVALID;
    const value = (this.b[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return value;
  }

  read(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) value = (value << 1) | this.bit();
    return value;
  }

  skip(count: number): void {
    this.pos += count;
    if (this.pos > this.end) throw INVALID;
  }

  /** Ein Codewort: Index im Codebuch */
  huffman(tree: Int16Array): number {
    let node = 0;
    for (;;) {
      node = tree[node * 2 + this.bit()];
      if (node < 0) return ~node;
    }
  }
}

const ID_SCE = 0;
const ID_CPE = 1;
const ID_DSE = 4;
const ID_FIL = 6;
const ID_END = 7;

const EIGHT_SHORT_SEQUENCE = 2;
/** Codebuch-Nummern ohne Spektralwerte: 0 (Null), 13 (Rauschen), 14 und 15 (Intensität); 12 ist reserviert */
const BOOK_RESERVED = 12;
const BOOK_NOISE = 13;

/** Fensteraufbau eines Kanals (ics_info) */
interface Windows {
  short: boolean;
  /** Skalenfaktorbänder je Fenstergruppe */
  maxSfb: number;
  /** Fenster je Gruppe: [1] im langen Fenster, bis zu acht Gruppen im kurzen */
  groups: number[];
  /** Grenzen der Skalenfaktorbänder eines Fensters */
  bands: number[];
}

function windows(r: BitReader, rateIndex: number): Windows {
  // ics_reserved_bit
  if (r.bit()) throw INVALID;
  const sequence = r.read(2);
  // window_shape
  r.skip(1);
  if (sequence === EIGHT_SHORT_SEQUENCE) {
    const bands = BANDS_SHORT[rateIndex];
    const maxSfb = r.read(4);
    // scale_factor_grouping: ein gesetztes Bit hängt das nächste Fenster an die laufende Gruppe
    const groups = [1];
    for (let i = 0; i < 7; i++) {
      if (r.bit()) groups[groups.length - 1]++;
      else groups.push(1);
    }
    if (maxSfb > bands.length - 1) throw INVALID;
    return { short: true, maxSfb, groups, bands };
  }
  const bands = BANDS_LONG[rateIndex];
  const maxSfb = r.read(6);
  // predictor_data_present: Vorhersage gibt es in AAC-LC nicht
  if (r.bit() || maxSfb > bands.length - 1) throw INVALID;
  return { short: false, maxSfb, groups: [1], bands };
}

/** individual_channel_stream: ein Kanal bis hinter seine Spektralwerte */
function channelStream(r: BitReader, rateIndex: number, shared: Windows | null): void {
  // global_gain
  r.skip(8);
  const w = shared ?? windows(r, rateIndex);

  // section_data: je Gruppe Abschnitte aus Codebuch und Länge, bis alle Bänder belegt sind
  const lengthBits = w.short ? 3 : 5;
  const lengthEscape = (1 << lengthBits) - 1;
  const books = new Uint8Array(w.groups.length * w.maxSfb);
  for (let g = 0; g < w.groups.length; g++) {
    for (let sfb = 0; sfb < w.maxSfb; ) {
      const book = r.read(4);
      if (book === BOOK_RESERVED) throw INVALID;
      let length = 0;
      let step: number;
      while ((step = r.read(lengthBits)) === lengthEscape) length += step;
      length += step;
      if (sfb + length > w.maxSfb) throw INVALID;
      books.fill(book, g * w.maxSfb + sfb, g * w.maxSfb + sfb + length);
      sfb += length;
    }
  }

  // scale_factor_data: je Band mit Codebuch ein Codewort; die erste Rauschenergie steht mit 9 Bit im Klartext
  let noisePcm = true;
  for (const book of books) {
    if (!book) continue;
    if (book === BOOK_NOISE && noisePcm) {
      noisePcm = false;
      r.skip(9);
    } else r.huffman(SCALEFACTOR_TREE);
  }

  // pulse_data: nur im langen Fenster, number_pulse und pulse_start_sfb, dann je Puls Versatz und Betrag
  if (r.bit()) {
    if (w.short) throw INVALID;
    const pulses = r.read(2) + 1;
    r.skip(6 + pulses * 9);
  }

  // tns_data: je Fenster Filter aus Länge, Ordnung, Richtung und Koeffizienten
  if (r.bit()) {
    for (let window = w.short ? 8 : 1; window > 0; window--) {
      const filters = r.read(w.short ? 1 : 2);
      if (!filters) continue;
      const resolution = r.bit();
      for (let f = 0; f < filters; f++) {
        r.skip(w.short ? 4 : 6);
        const order = r.read(w.short ? 3 : 5);
        if (!order) continue;
        r.skip(1);
        const compress = r.bit();
        r.skip(order * (resolution + 3 - compress));
      }
    }
  }

  // gain_control_data: Verstärkungsregelung gibt es in AAC-LC nicht
  if (r.bit()) throw INVALID;

  // spectral_data: je Band mit Codebuch 1 bis 11 Vierer (Codebuch 1 bis 4) oder Paare von Werten
  for (let g = 0; g < w.groups.length; g++) {
    for (let sfb = 0; sfb < w.maxSfb; sfb++) {
      const book = books[g * w.maxSfb + sfb];
      if (!book || book > ESCAPE_BOOK) continue;
      const tree = SPECTRAL_TREES[book - 1];
      const extra = SPECTRAL_EXTRA[book - 1];
      const width = book < 5 ? 4 : 2;
      for (let values = (w.bands[sfb + 1] - w.bands[sfb]) * w.groups[g]; values > 0; values -= width) {
        const after = extra[r.huffman(tree)];
        r.skip(after & 7);
        for (let escapes = after >> 3; escapes > 0; escapes--) {
          // Escape-Folge: N Einsen, eine Null, dann N + 4 Bit; mehr als 8 Einsen sind ungültig
          let ones = 0;
          while (r.bit()) if (++ones > 8) throw INVALID;
          r.skip(ones + 4);
        }
      }
    }
  }
}

/**
 * Liest die size Bytes ab start als genau einen AAC-LC-Frame
 * (raw_data_block) und liefert den Frame, der weitergeht: das eine
 * Kanal-Element, die Ende-Kennung, mit Nullen auf ganze Bytes aufgefüllt.
 * null: kein einzelner Frame der erlaubten Art, oder das Sample geht nach
 * dem Frame weiter (etwa mit einem zweiten Frame).
 */
export function aacFrame(b: Uint8Array, start: number, size: number, config: AacConfig): Uint8Array | null {
  const r = new BitReader(b, start, size);
  /** Bit-Bereich des Kanal-Elements */
  let from = -1;
  let to = -1;
  try {
    for (;;) {
      const at = r.pos;
      const id = r.read(3);
      if (id === ID_END) break;
      if (id === ID_SCE || id === ID_CPE) {
        // Genau ein Kanal-Element, passend zur Kanalzahl
        if (from >= 0 || (id === ID_SCE ? 1 : 2) !== config.channels) return null;
        // element_instance_tag
        r.skip(4);
        if (id === ID_SCE) channelStream(r, config.rateIndex, null);
        else {
          // common_window: beide Kanäle teilen den Fensteraufbau, dazu die Mitte/Seite-Maske
          let shared: Windows | null = null;
          if (r.bit()) {
            shared = windows(r, config.rateIndex);
            const mask = r.read(2);
            if (mask === 3) return null;
            if (mask === 1) r.skip(shared.groups.length * shared.maxSfb);
          }
          channelStream(r, config.rateIndex, shared);
          channelStream(r, config.rateIndex, shared);
        }
        from = at;
        to = r.pos;
      } else if (id === ID_DSE) {
        // data_stream_element: Kennung, Ausrichtung, Anzahl Bytes (255 heißt: ein weiteres Byte zählt dazu)
        r.skip(4);
        const align = r.bit();
        let count = r.read(8);
        if (count === 255) count += r.read(8);
        if (align) r.skip(-r.pos & 7);
        r.skip(count * 8);
      } else if (id === ID_FIL) {
        // fill_element: Anzahl Bytes (15 heißt: ein weiteres Byte zählt dazu, minus 1)
        let count = r.read(4);
        if (count === 15) count += r.read(8) - 1;
        r.skip(count * 8);
      } else return null;
    }
  } catch (e) {
    if (e === INVALID) return null;
    throw e;
  }
  // Nach der Ende-Kennung nur noch die Auffüllung bis zur Byte-Grenze: dort endet auch das Sample
  if (from < 0 || (r.pos + 7) >> 3 !== start + size) return null;

  const bits = to - from;
  const out = new Uint8Array((bits + 3 + 7) >> 3);
  const shift = from & 7;
  for (let i = 0, at = from >> 3; i < out.length; i++, at++) out[i] = ((b[at] << shift) | ((b[at + 1] ?? 0) >> (8 - shift))) & 0xff;
  // Hinter dem Kanal-Element: Ende-Kennung (drei Einsen), der Rest Nullen
  const last = bits >> 3;
  out[last] &= 0xff00 >> (bits & 7);
  out.fill(0, last + 1);
  for (let bit = bits; bit < bits + 3; bit++) out[bit >> 3] |= 0x80 >> (bit & 7);
  return out;
}
