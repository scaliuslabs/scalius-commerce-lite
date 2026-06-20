const CHECKOUT_SESSION_KEYS = [
  "scalius_checkout_data",
  "scalius_checkout_gateways",
  "checkoutId",
] as const;

const LEGACY_ANALYTICS_PII_KEYS = [
  "scalius_user_phone",
  "scalius_user_email",
  "scalius_user_name",
  "scalius_user_city",
] as const;

export function clearCheckoutSession(): void {
  try {
    for (const key of CHECKOUT_SESSION_KEYS) {
      sessionStorage.removeItem(key);
    }
    for (const key of LEGACY_ANALYTICS_PII_KEYS) {
      sessionStorage.removeItem(key);
    }
  } catch {
    // ignore storage access errors
  }
}
