// What an import found wrong with a file, row by row, and what it cannot
// carry over at all. Codes are stable (the dashboard translates them, agents
// branch on them); `message` is the English text for the error CSV and logs.

import { toCsv } from "./csv";

export type ImportIssueSeverity = "error" | "warning";

export interface ImportIssue {
  severity: ImportIssueSeverity;
  /** Stable code, e.g. `price_invalid`. */
  code: string;
  /** English explanation for the error CSV and agents. */
  message: string;
  /** 1-based line in the uploaded file (null for a whole-product issue without one row). */
  line: number | null;
  /** The product handle, SKU or customer phone the issue belongs to. */
  subject?: string | null;
  /** The column the value came from. */
  column?: string | null;
  /** Values the dashboard interpolates into its translated message. */
  params?: Record<string, string | number>;
}

/**
 * Something in the file Scalius has no place for. Reported once per kind
 * with a count, so a merchant sees "Tags on 412 products" rather than 412
 * warnings.
 */
export interface UnsupportedSummary {
  code: string;
  message: string;
  count: number;
  /** Up to three examples (handles, columns or values). */
  examples: string[];
}

export class UnsupportedCollector {
  private readonly entries = new Map<string, UnsupportedSummary>();

  add(code: string, message: string, example?: string | null): void {
    const entry = this.entries.get(code) ?? { code, message, count: 0, examples: [] };
    entry.count += 1;
    if (example && entry.examples.length < 3 && !entry.examples.includes(example)) entry.examples.push(example);
    this.entries.set(code, entry);
  }

  list(): UnsupportedSummary[] {
    return [...this.entries.values()];
  }
}

export const IMPORT_ERROR_CSV_HEADERS = ["Line", "Severity", "Subject", "Column", "Problem", "Code"] as const;

/** The downloadable report of every issue (UTF-8 with BOM, one row per issue). */
export function buildImportIssuesCsv(issues: readonly ImportIssue[]): string {
  return toCsv([
    [...IMPORT_ERROR_CSV_HEADERS],
    ...issues.map((issue) => [
      issue.line ?? "",
      issue.severity,
      issue.subject ?? "",
      issue.column ?? "",
      issue.message,
      issue.code,
    ]),
  ]);
}

/**
 * The rows of the original file that failed, with a leading "Import error"
 * column, so a merchant can fix them in place and upload just that file.
 */
export function buildFailedRowsCsv(
  headers: readonly string[],
  rows: ReadonlyArray<{ line: number; cells: readonly string[] }>,
  issues: readonly ImportIssue[],
): string {
  const byLine = new Map<number, string[]>();
  for (const issue of issues) {
    if (issue.severity !== "error" || issue.line === null) continue;
    const list = byLine.get(issue.line) ?? [];
    list.push(issue.message);
    byLine.set(issue.line, list);
  }
  return toCsv([
    ["Import error", ...headers],
    ...rows.filter((row) => byLine.has(row.line)).map((row) => [byLine.get(row.line)!.join(" "), ...row.cells]),
  ], { spreadsheetSafe: false });
}
