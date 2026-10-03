// One CSV cell for the dashboard's exports (orders, customers, purchase
// orders, reports): always quoted, and never something a spreadsheet would
// run as a formula. Store-transfer files keep their own round-trippable
// rules in ./store-transfer/csv.

/**
 * A quoted CSV cell: text whose first non-blank character is = + - or @ gets
 * a leading apostrophe, except an international phone number
 * ("+8801712345678"), which is data, not a formula. Dates are ISO strings.
 */
export function spreadsheetSafeCsvCell(value: unknown): string {
  const normalized = value == null
    ? ""
    : value instanceof Date
      ? value.toISOString()
      : String(value);
  const safe = /^[\t\r\n ]*[=+\-@]/.test(normalized) && !/^\+\d{6,15}$/.test(normalized)
    ? `'${normalized}`
    : normalized;
  return `"${safe.replaceAll('"', '""')}"`;
}
