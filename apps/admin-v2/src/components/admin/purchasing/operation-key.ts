// One operation key per stock intent (receive, ship, cancel in transit), as
// AdjustStockDialog does: retrying the same intent after a dropped
// connection sends the same key, so the API replays the first result instead
// of moving stock twice; a different intent (other quantities) gets a new key.
// After a success the key is retired, so the next, separate receipt of the
// same quantities is booked rather than replayed.
import { useState } from "react";

export interface OperationKeys {
  /** The key for this intent: the same one while the fingerprint repeats. */
  keyFor: (fingerprint: string) => string;
  /** Retire the current key (the command succeeded). */
  reset: () => void;
}

/** 16–128 characters of `[A-Za-z0-9._:-]`, starting alphanumeric (the API's rule). */
export function newOperationKey(): string {
  return `invcmd_${crypto.randomUUID()}`;
}

export function createOperationKeys(next: () => string = newOperationKey): OperationKeys {
  let current: { fingerprint: string; key: string } | null = null;
  return {
    keyFor(fingerprint) {
      if (current?.fingerprint === fingerprint) return current.key;
      current = { fingerprint, key: next() };
      return current.key;
    },
    reset() {
      current = null;
    },
  };
}

/** The page's operation keys; they live as long as the page. */
export function useOperationKeys(): OperationKeys {
  const [keys] = useState(() => createOperationKeys());
  return keys;
}

/** A receipt's fingerprint: the same lines in any order are the same intent. */
export function receiptFingerprint(
  documentId: string,
  lines: ReadonlyArray<{ lineId: string; quantity: number }>,
  extra: Record<string, unknown> = {},
): string {
  const sorted = [...lines].sort((left, right) => left.lineId.localeCompare(right.lineId));
  return JSON.stringify({ documentId, lines: sorted.map((line) => [line.lineId, line.quantity]), ...extra });
}
