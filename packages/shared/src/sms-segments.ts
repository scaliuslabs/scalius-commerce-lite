/**
 * How many SMS parts a message costs. GSM-7 text fits 160 characters in one
 * SMS and 153 per part once split; anything outside GSM-7 (Bangla, emoji,
 * curly quotes) switches the whole message to Unicode: 70, then 67 per part.
 * GSM extension characters (€ [ ] { } \ ~ ^ |) take two slots.
 */

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "\f^{}\\[~]|€";

const GSM_BASIC_SET = new Set(GSM_BASIC);
const GSM_EXTENDED_SET = new Set(GSM_EXTENDED);

export type SmsEncoding = "gsm7" | "unicode";

export interface SmsSegmentCount {
  /** Characters as a person counts them (a Bangla conjunct is several). */
  characters: number;
  segments: number;
  encoding: SmsEncoding;
}

export function countSmsSegments(text: string): SmsSegmentCount {
  const chars = Array.from(text);
  let gsmUnits = 0;
  let unicode = false;
  for (const char of chars) {
    if (GSM_BASIC_SET.has(char)) gsmUnits += 1;
    else if (GSM_EXTENDED_SET.has(char)) gsmUnits += 2;
    else {
      unicode = true;
      break;
    }
  }

  if (!unicode) {
    return {
      characters: chars.length,
      segments: gsmUnits === 0 ? 0 : gsmUnits <= 160 ? 1 : Math.ceil(gsmUnits / 153),
      encoding: "gsm7",
    };
  }

  // UCS-2 counts UTF-16 code units: an emoji takes two.
  const units = text.length;
  return {
    characters: chars.length,
    segments: units <= 70 ? 1 : Math.ceil(units / 67),
    encoding: "unicode",
  };
}
