const CHECKOUT_TRANSFER_KEYS = [
  "scalius_checkout_data",
  "scalius_checkout_gateways",
] as const;

const CHECKOUT_RUNTIME_KEYS = ["checkoutId"] as const;

export const CHECKOUT_TRANSFER_UNAVAILABLE_MESSAGE =
  "We could not open payment because this browser blocked checkout storage. Please allow site storage for this store, then try again.";

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

export function writeCheckoutTransferSession(
  checkoutData: Record<string, unknown>,
  gatewaysJson: string,
): { ok: true } | { ok: false; message: string } {
  const checkoutDataJson = JSON.stringify(checkoutData);

  try {
    sessionStorage.setItem("scalius_checkout_data", checkoutDataJson);

    if (sessionStorage.getItem("scalius_checkout_data") !== checkoutDataJson) {
      throw new Error("Checkout transfer storage was not persisted.");
    }
  } catch {
    try {
      removeSessionKeys(CHECKOUT_TRANSFER_KEYS);
    } catch {
      // ignore cleanup failures after storage denial
    }

    return {
      ok: false,
      message: CHECKOUT_TRANSFER_UNAVAILABLE_MESSAGE,
    };
  }

  try {
    sessionStorage.setItem("scalius_checkout_gateways", gatewaysJson);

    if (sessionStorage.getItem("scalius_checkout_gateways") !== gatewaysJson) {
      throw new Error("Checkout gateway transfer storage was not persisted.");
    }
  } catch {
    try {
      removeSessionKeys(["scalius_checkout_gateways"]);
    } catch {
      // ignore optional gateway snapshot cleanup failures
    }
  }

  return { ok: true };
}

export function clearCheckoutSession(): void {
  try {
    clearCheckoutTransferSession();
    removeSessionKeys(CHECKOUT_RUNTIME_KEYS);
  } catch {
    // ignore storage access errors
  }
}
