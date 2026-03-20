/**
 * Pure SVG barcode generator using Code 128B encoding.
 * No external dependencies. Produces a string of SVG markup.
 */

import { escapeHtml } from "./html-escape";

// Code 128 bit-patterns. Each entry is an 11-bit pattern (stop is 13 bits).
// '1' = black bar, '0' = white space.
const CODE128_BITS: string[] = [
  "11011001100", // 0
  "11001101100", // 1
  "11001100110", // 2
  "10010011000", // 3
  "10010001100", // 4
  "10001001100", // 5
  "10011001000", // 6
  "10011000100", // 7
  "10001100100", // 8
  "11001001000", // 9
  "11001000100", // 10
  "11000100100", // 11
  "10110011100", // 12
  "10011011100", // 13
  "10011001110", // 14
  "10111001100", // 15
  "10011101100", // 16
  "10011100110", // 17
  "11001110010", // 18
  "11001011100", // 19
  "11001001110", // 20
  "11011100100", // 21
  "11001110100", // 22
  "11101101110", // 23
  "11101001100", // 24
  "11100101100", // 25
  "11100100110", // 26
  "11101100100", // 27
  "11100110100", // 28
  "11100110010", // 29
  "11011011000", // 30
  "11011000110", // 31
  "11000110110", // 32
  "10100011000", // 33
  "10001011000", // 34
  "10001000110", // 35
  "10110001000", // 36
  "10001101000", // 37
  "10001100010", // 38
  "11010001000", // 39
  "11000101000", // 40
  "11000100010", // 41
  "10110111000", // 42
  "10110001110", // 43
  "10001101110", // 44
  "10111011000", // 45
  "10111000110", // 46
  "10001110110", // 47
  "11101110110", // 48
  "11010001110", // 49
  "11000101110", // 50
  "11011101000", // 51
  "11011100010", // 52
  "11011101110", // 53
  "11101011000", // 54
  "11101000110", // 55
  "11100010110", // 56
  "11101101000", // 57
  "11101100010", // 58
  "11100011010", // 59
  "11101111010", // 60
  "11001000010", // 61
  "11110001010", // 62
  "10100110000", // 63
  "10100001100", // 64
  "10010110000", // 65
  "10010000110", // 66
  "10000101100", // 67
  "10000100110", // 68
  "10110010000", // 69
  "10110000100", // 70
  "10011010000", // 71
  "10011000010", // 72
  "10000110100", // 73
  "10000110010", // 74
  "11000010010", // 75
  "11001010000", // 76
  "11110111010", // 77
  "11000010100", // 78
  "10001111010", // 79
  "10100111100", // 80
  "10010111100", // 81
  "10010011110", // 82
  "10111100100", // 83
  "10011110100", // 84
  "10011110010", // 85
  "11110100100", // 86
  "11110010100", // 87
  "11110010010", // 88
  "11011011110", // 89
  "11011110110", // 90
  "11110110110", // 91
  "10101111000", // 92
  "10100011110", // 93
  "10001011110", // 94
  "10111101000", // 95
  "10111100010", // 96
  "11110101000", // 97
  "11110100010", // 98
  "10111011110", // 99
  "10111101110", // 100
  "11101011110", // 101
  "11110101110", // 102
  "11010000100", // 103: START A
  "11010010000", // 104: START B
  "11010011100", // 105: START C
];

const CODE128_STOP = "1100011101011"; // 13-bit stop pattern

/**
 * Encode a string using Code 128B and return the binary pattern.
 * Code 128B supports ASCII 32-127 (printable characters).
 */
function encodeCode128B(data: string): string {
  const startCode = 104; // START B
  let checksum = startCode;
  let bits = CODE128_BITS[startCode] ?? '';

  for (let i = 0; i < data.length; i++) {
    const charCode = data.charCodeAt(i);
    const value = charCode - 32; // Code 128B: ASCII 32 = value 0
    if (value < 0 || value > 94) {
      throw new Error(`Character '${data[i]}' not supported in Code 128B`);
    }
    bits += CODE128_BITS[value] ?? '';
    checksum += value * (i + 1);
  }

  // Checksum
  const checksumValue = checksum % 103;
  bits += CODE128_BITS[checksumValue] ?? '';

  // Stop
  bits += CODE128_STOP;

  return bits;
}

export interface BarcodeSvgOptions {
  /** Width of narrowest bar in pixels. Default: 2 */
  moduleWidth?: number;
  /** Height of bars in pixels. Default: 60 */
  height?: number;
  /** Quiet zone (margin) in modules. Default: 10 */
  quietZone?: number;
  /** Show human-readable text below barcode. Default: true */
  showText?: boolean;
  /** Font size for text. Default: 14 */
  fontSize?: number;
}

/**
 * Generate an SVG barcode string from alphanumeric data.
 * Uses Code 128B encoding. Pure function, no dependencies.
 */
export function generateBarcodeSvg(
  data: string,
  options: BarcodeSvgOptions = {}
): string {
  const {
    moduleWidth = 2,
    height = 60,
    quietZone = 10,
    showText = true,
    fontSize = 14,
  } = options;

  const bits = encodeCode128B(data);
  const barcodeWidth = bits.length * moduleWidth;
  const totalWidth = barcodeWidth + quietZone * moduleWidth * 2;
  const totalHeight = showText ? height + fontSize + 8 : height;

  let bars = "";
  let x = quietZone * moduleWidth;

  for (let i = 0; i < bits.length; i++) {
    if (bits[i] === "1") {
      bars += `<rect x="${x}" y="0" width="${moduleWidth}" height="${height}"/>`;
    }
    x += moduleWidth;
  }

  let text = "";
  if (showText) {
    text = `<text x="${totalWidth / 2}" y="${height + fontSize + 2}" text-anchor="middle" font-family="monospace" font-size="${fontSize}">${escapeHtml(data)}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${totalHeight}" width="${totalWidth}" height="${totalHeight}">${bars}${text}</svg>`;
}

