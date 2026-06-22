const CHECKOUT_TRANSFER_KEYS = [
  "scalius_checkout_data",
  "scalius_checkout_gateways",
] as const;

const CHECKOUT_RUNTIME_KEYS = ["checkoutId"] as const;

const LEGACY_ANALYTICS_PII_KEYS = [
  "scalius_user_phone",
  "scalius_user_email",
  "scalius_user_name",
  "scalius_user_city",
] as const;

function removeSessionKeys(keys: readonly string[]): void {
  for (const key of keys) {
    sessionStorage.removeItem(key);
  }
}

export function clearCheckoutTransferSession(): void {
  try {
    removeSessionKeys(CHECKOUT_TRANSFER_KEYS);
    removeSessionKeys(LEGACY_ANALYTICS_PII_KEYS);
  } catch {
    // ignore storage access errors
  }
}

export function clearCheckoutSession(): void {
  try {
    clearCheckoutTransferSession();
    removeSessionKeys(CHECKOUT_RUNTIME_KEYS);
  } catch {
    // ignore storage access errors
  }
}
