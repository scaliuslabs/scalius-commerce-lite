// Counting arrivals with a keyboard-wedge barcode scanner: the scanner types
// the code and Enter. Each scan of a line's SKU or barcode adds one unit to
// that line, never past what is still to come.

export interface ScanLine {
  id: string;
  sku: string;
  barcode: string | null;
  /** Units still to come on this line (the most it can take). */
  max: number;
}

export type ScanOutcome =
  | { kind: "counted"; lineId: string; quantity: number }
  | { kind: "full"; lineId: string }
  | { kind: "unknown"; code: string };

export function normalizeScanCode(code: string): string {
  return code.trim().toLowerCase();
}

/**
 * Adds one unit for a scanned code. A code may name several lines (one SKU's
 * barcode equal to another's SKU); the first with room takes the unit.
 */
export function applyScan(
  lines: readonly ScanLine[],
  quantities: Readonly<Record<string, number | null>>,
  code: string,
): { quantities: Record<string, number | null>; outcome: ScanOutcome } {
  const needle = normalizeScanCode(code);
  const matches = needle
    ? lines.filter((line) => normalizeScanCode(line.sku) === needle || (line.barcode !== null && normalizeScanCode(line.barcode) === needle))
    : [];
  if (matches.length === 0) return { quantities: { ...quantities }, outcome: { kind: "unknown", code: code.trim() } };
  const counted = (line: ScanLine) => {
    const value = quantities[line.id] ?? 0;
    return value !== null && Number.isSafeInteger(value) && value > 0 ? value : 0;
  };
  const open = matches.find((line) => counted(line) < line.max);
  if (!open) return { quantities: { ...quantities }, outcome: { kind: "full", lineId: matches[0]!.id } };
  const quantity = counted(open) + 1;
  return { quantities: { ...quantities, [open.id]: quantity }, outcome: { kind: "counted", lineId: open.id, quantity } };
}
