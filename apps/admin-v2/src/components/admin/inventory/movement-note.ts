import type { InventoryMovement } from "~/lib/api-query-options/inventory";
import type { inventoryMessages } from "~/i18n/inventory";

type Key = keyof typeof inventoryMessages.en;

/** What a history row shows instead of the stored note: catalog labels plus a note a person typed. */
export type MovementNote = { labels: Key[]; note: string | null };

const ADJUST_REASONS: Record<string, Key> = {
  received: "reason_received",
  return: "reason_return",
  damage: "reason_damage",
  theft: "reason_theft",
  correction: "reason_correction",
  other: "reason_other",
};

// Fixed reasons sent by the warehouse scanner.
const SCANNER_REASONS: Record<string, Key> = {
  "Quick Receive": "reason_received",
  Receiving: "reason_received",
  "Quick Deduct": "reason_removed",
  Damaged: "reason_damage",
  Returned: "reason_return",
  Correction: "reason_correction",
  Transfer: "reason_transfer",
  "Undo scanner adjustment": "reason_undo",
};

const DASHBOARD_STOCKTAKE_REASON = "Manual stocktake";
const ORDER_SENTENCE = /^(Stock deducted|Deducted stock restored|Reserved \d+|Released \d+|Reservation released|Restored \d+)/;

/**
 * Stored movement notes are server sentences ("Stock deducted on … for order …",
 * "Stocktake: Option matrix edit") with an optional note a person typed. Map the
 * known sentences to catalog labels and keep only the person's own words.
 */
export function describeMovementNote(
  movement: Pick<InventoryMovement, "notes" | "orderId" | "actorType">,
): MovementNote {
  const text = movement.notes?.trim() ?? "";
  if (!text) return { labels: [], note: null };

  const manual = /^Manual adjustment \((\w+)\)(?:: ([\s\S]*))?$/.exec(text);
  if (manual) {
    return { labels: ADJUST_REASONS[manual[1]!] ? [ADJUST_REASONS[manual[1]!]!] : [], note: manual[2] || null };
  }

  const scanner = /^Scanner adjustment \(([^)]*)\)(?:: ([\s\S]*))?$/.exec(text);
  if (scanner) {
    const reason = SCANNER_REASONS[scanner[1]!];
    return { labels: reason ? ["sourceScanner", reason] : ["sourceScanner"], note: scanner[2] || null };
  }

  const stocktake = /^Stocktake \(([\s\S]*?)\): set from -?\d+ to -?\d+(?:: ([\s\S]*))?$/.exec(text);
  if (stocktake) {
    const typed = [stocktake[1], stocktake[2]].filter((part) => part && part !== DASHBOARD_STOCKTAKE_REASON);
    return { labels: ["sourceStockCount"], note: typed.join(" · ") || null };
  }

  if (/^Stocktake: Initial /.test(text) || /^Stocktake: Allocated /.test(text)) {
    return { labels: ["sourceProductCreated"], note: null };
  }
  if (text.startsWith("Stocktake: ")) return { labels: ["sourceProductEdit"], note: null };
  if (/rollback/i.test(text)) return { labels: ["sourceCheckoutFailed"], note: null };
  if (/^expired /.test(text)) return { labels: ["sourceHoldExpired"], note: null };

  // Order and system sentences are said by the type badge and order link; keep only people's notes.
  const typedByPerson = movement.actorType !== "system" && !movement.orderId && !ORDER_SENTENCE.test(text);
  return { labels: [], note: typedByPerson ? text : null };
}
