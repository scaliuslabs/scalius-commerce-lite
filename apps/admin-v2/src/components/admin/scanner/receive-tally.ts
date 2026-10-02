// Receiving by scan: each scan of a line's barcode or SKU counts one unit
// toward that line, up to what is still open on the purchase order (or in
// transit on the transfer). Nothing is booked until the clerk confirms; then
// one receive command books every counted unit, with one operation key per
// intent so a retry of the same count replays instead of receiving twice.

/** One line still to receive. */
export interface ReceiveLine {
  id: string;
  sku: string;
  barcode: string | null;
  productName: string | null;
  optionLabel: string | null;
  /** Units still to receive (open on the PO, in transit on the transfer). */
  open: number;
  /**
   * Can't be received: a purchase order line whose SKU was removed from its
   * product (the API refuses it). A transfer's units are already on the road,
   * so its retired SKUs still arrive.
   */
  blocked?: boolean;
}

/** Units counted so far, by line id (lines not counted are absent). */
export type ReceiveTally = Readonly<Record<string, number>>;

export type ScanOutcome =
  | { kind: "counted"; line: ReceiveLine; counted: number }
  /** Every open unit of the line is already counted. */
  | { kind: "full"; line: ReceiveLine }
  /** The line can't be received (a retired SKU on a purchase order). */
  | { kind: "blocked"; line: ReceiveLine }
  /** The code is on no line of this document. */
  | { kind: "unknown" };

const normalized = (code: string | null | undefined) => (code ?? "").trim().toLowerCase();

/** The line a scanned code belongs to: its barcode first, else its SKU (case and spaces ignored). */
export function matchLine(lines: readonly ReceiveLine[], code: string): ReceiveLine | null {
  const wanted = normalized(code);
  if (!wanted) return null;
  return lines.find((line) => normalized(line.barcode) === wanted)
    ?? lines.find((line) => normalized(line.sku) === wanted)
    ?? null;
}

/** Counts one scanned unit, never past what is still open. */
export function tallyScan(
  lines: readonly ReceiveLine[],
  tally: ReceiveTally,
  code: string,
): { tally: ReceiveTally; outcome: ScanOutcome } {
  const line = matchLine(lines, code);
  if (!line) return { tally, outcome: { kind: "unknown" } };
  if (line.blocked) return { tally, outcome: { kind: "blocked", line } };
  const counted = tally[line.id] ?? 0;
  if (counted >= line.open) return { tally, outcome: { kind: "full", line } };
  return { tally: { ...tally, [line.id]: counted + 1 }, outcome: { kind: "counted", line, counted: counted + 1 } };
}

/** Sets a line's count by hand (the − and + buttons), kept between 0 and what is open. */
export function setCounted(lines: readonly ReceiveLine[], tally: ReceiveTally, lineId: string, count: number): ReceiveTally {
  const line = lines.find((candidate) => candidate.id === lineId);
  if (!line || line.blocked) return tally;
  const next = Math.max(0, Math.min(line.open, Math.trunc(count)));
  if (next === (tally[lineId] ?? 0)) return tally;
  const { [lineId]: _previous, ...rest } = tally;
  return next === 0 ? rest : { ...rest, [lineId]: next };
}

/** A document reloaded after a receipt or a refusal: counts shrink to what is still open. */
export function clampTally(lines: readonly ReceiveLine[], tally: ReceiveTally): ReceiveTally {
  return lines.reduce<ReceiveTally>((next, line) => {
    const counted = line.blocked ? 0 : Math.min(tally[line.id] ?? 0, line.open);
    return counted > 0 ? { ...next, [line.id]: counted } : next;
  }, {});
}

export function countedTotal(tally: ReceiveTally): number {
  return Object.values(tally).reduce((total, count) => total + count, 0);
}

/** The receive command's lines: every counted line, in the document's order. */
export function receiveLines(lines: readonly ReceiveLine[], tally: ReceiveTally): Array<{ lineId: string; quantity: number }> {
  return lines.flatMap((line) => ((tally[line.id] ?? 0) > 0 ? [{ lineId: line.id, quantity: tally[line.id]! }] : []));
}

/**
 * One operation key per receive intent (the document at its revision, the
 * counted lines and, for a PO, whether costs move): the same intent sent
 * again after an unknown outcome (a dropped connection, a second tap) reuses
 * its key, so the server replays the first receipt instead of booking twice.
 * `settle` forgets the intent once its outcome is known (booked or refused),
 * so the next delivery of the same count is a new receipt.
 */
export function createIntentKeys(newKey: () => string = () => `invop_${crypto.randomUUID()}`) {
  let current: { fingerprint: string; key: string } | null = null;
  return {
    keyFor(fingerprint: string): string {
      if (current?.fingerprint !== fingerprint) current = { fingerprint, key: newKey() };
      return current.key;
    },
    settle() {
      current = null;
    },
  };
}

export function receiveFingerprint(intent: {
  kind: "purchaseOrder" | "transfer";
  documentId: string;
  revision: number;
  lines: ReadonlyArray<{ lineId: string; quantity: number }>;
  updateCost?: boolean;
}): string {
  return JSON.stringify([
    intent.kind,
    intent.documentId,
    intent.revision,
    intent.lines.map((line) => [line.lineId, line.quantity]),
    Boolean(intent.updateCost),
  ]);
}
