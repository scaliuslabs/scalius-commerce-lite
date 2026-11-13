import { getTrustedClientIpFromRequest } from "./client-ip";
import { requireWithinRateLimit } from "./rate-limit";

/** Shared by cart validation, quotes and new order preparation (after replay). */
export async function enforceCheckoutPreparationLimit(env: Env, request: Request): Promise<void> {
  // The standard budget (60/minute) bounds expensive app and tax work even
  // for invalid carts. Its purpose is separate from the buyer's commit quota.
  await requireWithinRateLimit(env, "RL_STANDARD", "checkout-prepare", getTrustedClientIpFromRequest(request, env), "Too many order requests. Please try again in a minute.");
}
