import { sha256Hex } from "@scalius/shared/hash";
import type { HostedPaymentRecoverySession } from "./session-state";

/** Only a durable, cancelled and archived unpaid order permits starting over. */
export async function inspectCheckoutRecovery(
  recovery: HostedPaymentRecoverySession,
): Promise<"expired" | "active" | "unknown"> {
  if (!recovery.checkoutId) return "unknown";
  try {
    const statusToken = `cst_${await sha256Hex(recovery.checkoutId.trim())}`;
    const response = await fetch("/api/checkout/recovery-status", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ statusToken }),
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return "unknown";
    const payload = await response.json() as {
      success?: boolean;
      data?: { orderId?: unknown; status?: unknown };
    } | null;
    if (payload?.success !== true || payload.data?.orderId !== recovery.orderId) return "unknown";
    if (payload.data.status === "expired") return "expired";
    return payload.data.status === "completed" ? "active" : "unknown";
  } catch {
    return "unknown";
  }
}
