const CHECKOUT_TRANSFER_KEYS = [
  "scalius_checkout_data",
  "scalius_checkout_gateways",
] as const;

const CHECKOUT_RUNTIME_KEYS = ["checkoutId"] as const;
const HOSTED_PAYMENT_RECOVERY_STORAGE_KEY = "scalius_hosted_payment_recovery";
const HOSTED_PAYMENT_RECOVERY_TTL_MS = 30 * 60 * 1000;
const HOSTED_PAYMENT_GATEWAYS = new Set(["sslcommerz", "polar"]);

export interface HostedPaymentRecoverySession {
  href: string;
  gateway: "sslcommerz" | "polar";
  createdAt: number;
}

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

function checkoutRecoveryBaseOrigin(): string {
  return typeof window !== "undefined" && window.location?.origin
    ? window.location.origin
    : "https://storefront.local";
}

function normalizeHostedPaymentRecoveryHref(href: string): HostedPaymentRecoverySession | null {
  try {
    const baseOrigin = checkoutRecoveryBaseOrigin();
    const url = new URL(href, baseOrigin);
    if (url.origin !== baseOrigin) return null;
    if (url.pathname !== "/order-success") return null;

    const gateway = url.searchParams.get("payment");
    if (!gateway || !HOSTED_PAYMENT_GATEWAYS.has(gateway)) return null;
    if (!url.searchParams.get("orderId") || !url.searchParams.get("token")) return null;

    return {
      href: `${url.pathname}${url.search}`,
      gateway: gateway as HostedPaymentRecoverySession["gateway"],
      createdAt: Date.now(),
    };
  } catch {
    return null;
  }
}

export function writeHostedPaymentRecoverySession(href: string | undefined): boolean {
  if (!href) return false;
  const recovery = normalizeHostedPaymentRecoveryHref(href);
  if (!recovery) return false;

  try {
    sessionStorage.setItem(
      HOSTED_PAYMENT_RECOVERY_STORAGE_KEY,
      JSON.stringify(recovery),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearHostedPaymentRecoverySession(): void {
  try {
    sessionStorage.removeItem(HOSTED_PAYMENT_RECOVERY_STORAGE_KEY);
  } catch {
    // ignore storage access errors
  }
}

export function readHostedPaymentRecoverySession(
  now = Date.now(),
): HostedPaymentRecoverySession | null {
  try {
    const raw = sessionStorage.getItem(HOSTED_PAYMENT_RECOVERY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<HostedPaymentRecoverySession>;
    if (
      typeof parsed.href !== "string" ||
      typeof parsed.createdAt !== "number" ||
      now - parsed.createdAt > HOSTED_PAYMENT_RECOVERY_TTL_MS
    ) {
      clearHostedPaymentRecoverySession();
      return null;
    }

    const normalized = normalizeHostedPaymentRecoveryHref(parsed.href);
    if (!normalized || normalized.gateway !== parsed.gateway) {
      clearHostedPaymentRecoverySession();
      return null;
    }

    return {
      ...normalized,
      createdAt: parsed.createdAt,
    };
  } catch {
    clearHostedPaymentRecoverySession();
    return null;
  }
}
