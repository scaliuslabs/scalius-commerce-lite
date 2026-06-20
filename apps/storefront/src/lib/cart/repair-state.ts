import type { CartValidationIssue } from "../api/orders";

export const CHECKOUT_CART_REPAIR_STORAGE_KEY = "scalius_cart_repair_state";
const REPAIR_STATE_MAX_AGE_MS = 5 * 60 * 1000;

export interface CartRepairState {
  source: "checkout";
  message: string;
  issues: CartValidationIssue[];
  createdAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCartValidationIssue(value: unknown): value is CartValidationIssue {
  return (
    isRecord(value) &&
    typeof value.index === "number" &&
    typeof value.productId === "string" &&
    typeof value.message === "string"
  );
}

export function writeCartRepairState(state: Omit<CartRepairState, "createdAt">): void {
  try {
    sessionStorage.setItem(
      CHECKOUT_CART_REPAIR_STORAGE_KEY,
      JSON.stringify({ ...state, createdAt: Date.now() }),
    );
  } catch {
    // Best-effort UI handoff. Cart reload validation remains the authority.
  }
}

export function readAndClearCartRepairState(now = Date.now()): CartRepairState | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(CHECKOUT_CART_REPAIR_STORAGE_KEY);
    sessionStorage.removeItem(CHECKOUT_CART_REPAIR_STORAGE_KEY);
  } catch {
    return null;
  }

  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    if (parsed.source !== "checkout") return null;
    if (typeof parsed.message !== "string") return null;
    if (typeof parsed.createdAt !== "number" || now - parsed.createdAt > REPAIR_STATE_MAX_AGE_MS) return null;
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.filter(isCartValidationIssue)
      : [];

    return {
      source: "checkout",
      message: parsed.message,
      issues,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}
