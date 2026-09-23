import type { OrderFormMode } from "~/components/admin/order-form/types";

interface Readiness {
  allowed: boolean;
  reason: string | null;
}

/**
 * One "Edit order" screen for two server workflows that never overlap: the full
 * editor (orders without a tax snapshot) and the quote-backed amendment (manual
 * COD orders with one). Anything else is locked with the server's reason.
 */
export function orderEditMode(data: {
  fullEditReadiness: Readiness;
  amendmentReadiness: Readiness;
}): { mode: Exclude<OrderFormMode, "create"> } | { mode: "locked"; reason: string | null } {
  if (data.fullEditReadiness.allowed) return { mode: "edit" };
  if (data.amendmentReadiness.allowed) return { mode: "amend" };
  return {
    mode: "locked",
    reason: data.fullEditReadiness.reason ?? data.amendmentReadiness.reason,
  };
}
