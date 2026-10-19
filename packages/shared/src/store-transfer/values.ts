// Cell readers shared by every import mapper: header lookup that ignores case
// and spacing, and the value conventions of Shopify, WooCommerce and Excel
// (TRUE/FALSE, yes/no, 1/0, Bengali digits, thousands separators, a leading
// apostrophe that keeps a number as text).

import { toLatinDigits } from "../phone-input";

/** A parsed CSV: its header cells and its data records (line numbers kept for errors). */
export interface CsvTable {
  headers: string[];
  rows: Array<{ line: number; cells: string[] }>;
}

export function normalizeHeader(header: string): string {
  return header.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Column lookup by header name, ignoring case and repeated spaces. */
export class ColumnIndex {
  private readonly index = new Map<string, number>();
  readonly headers: readonly string[];

  constructor(headers: readonly string[]) {
    this.headers = headers;
    headers.forEach((header, position) => {
      const key = normalizeHeader(header);
      if (key && !this.index.has(key)) this.index.set(key, position);
    });
  }

  has(name: string): boolean {
    return this.index.has(normalizeHeader(name));
  }

  /** The first of `names` the file has, or null. */
  find(...names: string[]): string | null {
    for (const name of names) if (this.has(name)) return name;
    return null;
  }

  position(name: string): number | undefined {
    return this.index.get(normalizeHeader(name));
  }

  /** The first non-empty cleaned cell (see `cleanImportCell`) among `names`; "" when none. */
  get(cells: readonly string[], ...names: string[]): string {
    for (const name of names) {
      const position = this.index.get(normalizeHeader(name));
      if (position === undefined) continue;
      const value = cleanImportCell(cells[position] ?? "");
      if (value) return value;
    }
    return "";
  }

  /** Headers matching a pattern (e.g. every `Attribute N name`). */
  matching(pattern: RegExp): string[] {
    return this.headers.filter((header) => pattern.test(normalizeHeader(header)));
  }
}

/**
 * A cell as data: trimmed, and without the apostrophe a spreadsheet (or our
 * own spreadsheet-safe export) puts in front of a number, phone or formula
 * character to keep it as text.
 */
export function cleanImportCell(value: string): string {
  const trimmed = value.trim();
  return /^'[\d+=\-@\t]/.test(trimmed) ? trimmed.slice(1) : trimmed;
}

/** TRUE/FALSE, yes/no, y/n, 1/0, on/off (any case); null when blank or anything else. */
export function parseImportBoolean(value: string): boolean | null {
  const text = value.trim().toLowerCase();
  if (["true", "yes", "y", "1", "on", "subscribed", "হ্যাঁ"].includes(text)) return true;
  if (["false", "no", "n", "0", "off", "not_subscribed", "unsubscribed", "না"].includes(text)) return false;
  return null;
}

/** `negative`: a number below 0 ("-5"), which no amount, weight or quantity here may be. */
export type ParsedNumber = { ok: true; value: number | null } | { ok: false; negative?: true };

/** Why an amount column was refused, in the row's words: below 0, or not a number at all. */
export function importNumberProblem(label: string, raw: string, parsed: ParsedNumber): string {
  return !parsed.ok && parsed.negative ? `${label} "${raw}" must be 0 or more.` : `${label} "${raw}" is not a number.`;
}

/**
 * A decimal amount as spreadsheets write it: "1,250.50", "৳ 1,250", "১২৫০",
 * "1 250", or a decimal comma ("12,50"). Blank is `{ ok: true, value: null }`.
 */
export function parseImportDecimal(value: string): ParsedNumber {
  let text = toLatinDigits(value).trim();
  if (!text) return { ok: true, value: null };
  // A minus sign (ASCII or U+2212) before an otherwise valid amount ("-5", "-৳ 1,250"): a number, but below 0.
  const negative = /^[-\u2212]/.test(text);
  if (negative) text = text.slice(1).trimStart();
  text = text.replace(/^(?:৳|tk\.?|bdt|taka|\$|usd|€|£|rs\.?)\s*/i, "").replace(/\s*(?:৳|tk\.?|bdt|taka)$/i, "");
  text = text.replace(/[\s\u00A0\u202F]/g, "");
  if (/^\d{1,3}(,\d{2})+,\d{3}(\.\d+)?$/.test(text)) {
    // Indian/Bangladeshi grouping: 1,25,000
    text = text.replaceAll(",", "");
  } else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) {
    text = text.replaceAll(",", "");
  } else if (/^\d{1,3}(\.\d{3})+,\d+$/.test(text)) {
    text = text.replaceAll(".", "").replace(",", ".");
  } else if (/^\d+,\d{1,2}$/.test(text)) {
    text = text.replace(",", ".");
  }
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false };
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return { ok: false };
  return negative && parsed > 0 ? { ok: false, negative: true } : { ok: true, value: parsed };
}

/** A whole number ("12", "১২", "12.0"); fractions and words fail. */
export function parseImportInteger(value: string): ParsedNumber {
  const parsed = parseImportDecimal(value);
  if (!parsed.ok || parsed.value === null) return parsed;
  return Number.isInteger(parsed.value) ? parsed : { ok: false };
}

/** True when Excel turned a long number (a phone, a barcode) into "8.80171E+12". */
export function isScientificNotation(value: string): boolean {
  return /^\d+(\.\d+)?e\+?\d+$/i.test(value.trim());
}

/** Comma separated list; `\,` (WooCommerce) is a literal comma. Empty items are dropped. */
export function splitImportList(value: string, separator = ","): string[] {
  const items: string[] = [];
  let current = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === "\\" && value[index + 1] === separator) {
      current += separator;
      index += 1;
    } else if (char === separator) {
      items.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  items.push(current);
  return items.map((item) => item.trim()).filter(Boolean);
}

/** Text cut to `max` characters without splitting a surrogate pair or a Bangla conjunct mid-sign. */
export function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  const chars = [...value.normalize("NFC")];
  let text = chars.slice(0, max).join("");
  // Never end on a combining sign or hasanta without its letter.
  text = text.replace(/[ঁ-ঃ়া-্ৗ‌‍]+$/u, "");
  return text.slice(0, max).trimEnd();
}

/** Stable short hash of text (FNV-1a, base 36): for generated identities that must not change between runs. */
export function stableHash(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}
