// An approval summary as stored and shown: typed rows the approval page
// labels by kind, never by their text. Writing the rows needs the operation's
// schema (./mcp/confirm-summary.ts, on the agent dispatch path, where the
// manifest is loaded); reading, cleaning and rendering stored rows needs none,
// so the approvals runtime never loads the agent manifest.

export const SUMMARY_ROW_KINDS = ["change", "money", "target", "setting", "words", "note"] as const;
export type SummaryRowKind = (typeof SUMMARY_ROW_KINDS)[number];

/** One row of an approval summary; the page labels it by `kind`, never by its text. */
export interface SummaryRow {
  kind: SummaryRowKind;
  /** The operation the row belongs to. */
  operationId: string;
  /** The input field it shows (`amount`, `set.*.prices.*.amount`), or null. */
  field: string | null;
  /** The value, cleaned and bounded: a title, ids, a setting's value, the agent's words. */
  text: string;
  /** Money rows: the amount in major units, formatted (`99999.00`). */
  amount?: string;
  /** Money rows: the ISO 4217 code, or null when it cannot be resolved. */
  currency?: string | null;
}

export const SUMMARY_TEXT_MAX = 240;
/** Control characters, line and paragraph separators, and Unicode format characters (direction overrides, zero-width). */
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

/** A text value as the page may show it: one line, no direction tricks, visibly cut. */
export function cleanSummaryText(value: string, max = SUMMARY_TEXT_MAX): string {
  const text = value.replace(UNSAFE_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}… (cut, ${text.length} characters)` : text;
}

const ROW_LABEL: Record<SummaryRowKind, string> = {
  change: "Change",
  money: "Amount",
  target: "Acts on",
  setting: "Setting",
  words: "The agent's own words (not checked by Scalius)",
  note: "Note",
};

/** The rows as one plain text, for the agent and the CLI (the page renders the rows). */
export function summaryText(rows: readonly SummaryRow[]): string {
  return rows.map((row) => {
    const value = row.kind === "money"
      ? `${row.amount ?? ""} ${row.currency ?? "(currency unknown)"}${row.text ? ` (${row.text})` : ""}`.trim()
      : row.kind === "change" ? `${row.text} (${row.operationId})` : row.text;
    return `${ROW_LABEL[row.kind]}: ${row.field ? `${row.field} ` : ""}${row.kind === "words" ? JSON.stringify(value) : value}`;
  }).join("\n");
}
