const CHECKOUT_TRANSFER_KEYS = [
  "scalius_checkout_data",
  "scalius_checkout_gateways",
  "scalius_checkout_payment_method",
] as const;

const CHECKOUT_RUNTIME_KEYS = ["checkoutId"] as const;
const CHECKOUT_FORM_DRAFT_KEY = "scalius_checkout_form_draft";
const CHECKOUT_FORM_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const CHECKOUT_FORM_DRAFT_FIELDS = [
  "customerName",
  "customerPhone",
  "customerEmail",
  "shippingAddress",
  "city",
  "cityName",
  "zone",
  "zoneName",
  "area",
  "areaName",
  "shippingLocation",
  "notes",
] as const;
const CHECKOUT_TRANSFER_SYNC_FIELDS = [
  ...CHECKOUT_FORM_DRAFT_FIELDS,
  "cartItems",
  "checkoutId",
  "checkoutRequestId",
  "discountCodeHidden",
  "shippingMethodId",
  "shippingCharge",
] as const;
const HOSTED_PAYMENT_RECOVERY_STORAGE_KEY = "scalius_hosted_payment_recovery";
const HOSTED_PAYMENT_RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHECKOUT_RECOVERY_GATEWAYS = new Set(["cod", "stripe", "sslcommerz", "polar"]);

type CheckoutRecoveryGateway = "cod" | "stripe" | "sslcommerz" | "polar";
type CheckoutFormDraftField = (typeof CHECKOUT_FORM_DRAFT_FIELDS)[number];

export type CheckoutFormDraft = Partial<Record<CheckoutFormDraftField, string>>;

type StoredCheckoutFormDraft = {
  version: 1;
  updatedAt: number;
  values: CheckoutFormDraft;
};

export interface HostedPaymentRecoverySession {
  href: string;
  gateway: CheckoutRecoveryGateway;
  orderId: string;
  checkoutId: string | null;
  cartFingerprint: string | null;
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

export function writeCheckoutFormDraft(values: CheckoutFormDraft): void {
  const safeValues: CheckoutFormDraft = {};
  for (const field of CHECKOUT_FORM_DRAFT_FIELDS) {
    const value = values[field];
    if (typeof value === "string") safeValues[field] = value.slice(0, 5000);
  }

  const stored: StoredCheckoutFormDraft = {
    version: 1,
    updatedAt: Date.now(),
    values: safeValues,
  };
  try {
    sessionStorage.setItem(CHECKOUT_FORM_DRAFT_KEY, JSON.stringify(stored));
  } catch {
    // Draft persistence is a convenience; checkout submission still fails closed
    // through the required transfer-state write below.
  }
}

export function readCheckoutFormDraft(): CheckoutFormDraft | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(CHECKOUT_FORM_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredCheckoutFormDraft>;
    if (
      parsed.version !== 1 ||
      typeof parsed.updatedAt !== "number" ||
      Date.now() - parsed.updatedAt > CHECKOUT_FORM_DRAFT_TTL_MS ||
      !parsed.values ||
      typeof parsed.values !== "object" ||
      Array.isArray(parsed.values)
    ) {
      sessionStorage.removeItem(CHECKOUT_FORM_DRAFT_KEY);
      return null;
    }

    const safeValues: CheckoutFormDraft = {};
    for (const field of CHECKOUT_FORM_DRAFT_FIELDS) {
      const value = parsed.values[field];
      if (typeof value === "string") safeValues[field] = value.slice(0, 5000);
    }
    return safeValues;
  } catch {
    try {
      sessionStorage.removeItem(CHECKOUT_FORM_DRAFT_KEY);
    } catch {
      // ignore storage cleanup errors
    }
    return null;
  }
}

export function clearCheckoutFormDraft(): void {
  try {
    sessionStorage.removeItem(CHECKOUT_FORM_DRAFT_KEY);
  } catch {
    // ignore storage access errors
  }
}

export function writeCheckoutPaymentSelection(methodId: string): void {
  if (!/^[a-z0-9_-]{1,64}$/i.test(methodId)) return;
  try {
    sessionStorage.setItem("scalius_checkout_payment_method", methodId);
  } catch {
    // fall back to the merchant default when storage is unavailable
  }
}

export function readCheckoutPaymentSelection(): string | null {
  try {
    const methodId = sessionStorage.getItem("scalius_checkout_payment_method");
    return methodId && /^[a-z0-9_-]{1,64}$/i.test(methodId) ? methodId : null;
  } catch {
    return null;
  }
}

export function syncCheckoutTransferSession(
  values: Record<string, string>,
): boolean {
  try {
    const raw = sessionStorage.getItem("scalius_checkout_data");
    if (!raw) return false;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const next = { ...(parsed as Record<string, unknown>) };
    for (const field of CHECKOUT_TRANSFER_SYNC_FIELDS) {
      const value = values[field];
      if (typeof value === "string") next[field] = value.slice(0, 50_000);
    }
    sessionStorage.setItem("scalius_checkout_data", JSON.stringify(next));
    return true;
  } catch {
    return false;
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
  clearCheckoutAttemptSession();
}

export function clearCheckoutAttemptSession(options?: {
  preserveFormDraft?: boolean;
}): void {
  try {
    clearCheckoutTransferSession();
    if (options?.preserveFormDraft !== true) clearCheckoutFormDraft();
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

function normalizeCheckoutRecoveryGateway(value: unknown): CheckoutRecoveryGateway | null {
  return typeof value === "string" && CHECKOUT_RECOVERY_GATEWAYS.has(value)
    ? value as CheckoutRecoveryGateway
    : null;
}

function normalizeHostedPaymentRecoveryHref(
  href: string,
  expectedGateway?: string | null,
): Pick<HostedPaymentRecoverySession, "href" | "gateway" | "orderId"> | null {
  try {
    const baseOrigin = checkoutRecoveryBaseOrigin();
    const url = new URL(href, baseOrigin);
    if (url.origin !== baseOrigin) return null;
    if (url.pathname !== "/order-success") return null;

    const storedGateway = normalizeCheckoutRecoveryGateway(expectedGateway);
    const queryGateway = normalizeCheckoutRecoveryGateway(url.searchParams.get("payment"));
    const gateway = storedGateway ?? queryGateway;
    if (!gateway || (queryGateway && queryGateway !== gateway)) return null;
    if (
      url.searchParams.has("token") ||
      url.searchParams.has("receipt_token") ||
      url.searchParams.has("receiptToken")
    ) {
      return null;
    }
    const orderId = url.searchParams.get("orderId")?.trim() ?? "";
    if (!orderId) return null;

    return {
      href: `${url.pathname}${url.search}`,
      gateway,
      orderId,
    };
  } catch {
    return null;
  }
}

function normalizeCheckoutId(checkoutData: Record<string, unknown> | undefined): string | null {
  const value = checkoutData?.checkoutRequestId ?? checkoutData?.checkoutId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

type FingerprintLine = {
  key: string;
  productId: string;
  variantId: string | null;
  quantity: number;
};

export function fingerprintCheckoutCart(value: unknown): string | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const lines = Object.entries(parsed as Record<string, unknown>)
    .map<FingerprintLine | null>(([key, raw]) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const item = raw as Record<string, unknown>;
      const productId = typeof item.id === "string" ? item.id.trim() : "";
      const variantId = typeof item.variantId === "string" && item.variantId.trim()
        ? item.variantId.trim()
        : null;
      const quantity = typeof item.quantity === "number" && Number.isFinite(item.quantity)
        ? Math.max(1, Math.floor(item.quantity))
        : 1;
      return productId ? { key, productId, variantId, quantity } : null;
    })
    .filter((line): line is FingerprintLine => line !== null)
    .sort((left, right) => left.key.localeCompare(right.key));

  return lines.length > 0 ? JSON.stringify(lines) : null;
}

export function matchesCheckoutRecoveryCart(
  recovery: HostedPaymentRecoverySession | null | undefined,
  cartItems: unknown,
): boolean {
  return Boolean(
    recovery?.cartFingerprint &&
    recovery.cartFingerprint === fingerprintCheckoutCart(cartItems),
  );
}

export function matchesCheckoutRecoverySession(
  recovery: HostedPaymentRecoverySession | null | undefined,
  cartItems: unknown,
): boolean {
  if (!matchesCheckoutRecoveryCart(recovery, cartItems)) return false;
  if (!recovery?.checkoutId) return true;
  try {
    return sessionStorage.getItem("checkoutId") === recovery.checkoutId;
  } catch {
    return false;
  }
}

export function writeHostedPaymentRecoverySession(
  href: string | undefined,
  checkoutData?: Record<string, unknown>,
  gateway?: string | null,
): boolean {
  if (!href) return false;
  const normalized = normalizeHostedPaymentRecoveryHref(href, gateway);
  if (!normalized) return false;
  const previous = readHostedPaymentRecoverySession();
  const canPreservePrevious = previous?.orderId === normalized.orderId;
  const hasCheckoutIdentity = Boolean(
    checkoutData && (
      Object.prototype.hasOwnProperty.call(checkoutData, "checkoutRequestId") ||
      Object.prototype.hasOwnProperty.call(checkoutData, "checkoutId")
    ),
  );
  const hasCartSnapshot = Boolean(
    checkoutData && Object.prototype.hasOwnProperty.call(checkoutData, "cartItems"),
  );
  const recovery: HostedPaymentRecoverySession = {
    ...normalized,
    checkoutId: hasCheckoutIdentity
      ? normalizeCheckoutId(checkoutData)
      : canPreservePrevious ? previous.checkoutId : null,
    cartFingerprint: hasCartSnapshot
      ? fingerprintCheckoutCart(checkoutData?.cartItems)
      : canPreservePrevious ? previous.cartFingerprint : null,
    createdAt: Date.now(),
  };

  try {
    localStorage.setItem(
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
    localStorage.removeItem(HOSTED_PAYMENT_RECOVERY_STORAGE_KEY);
  } catch {
    // ignore storage access errors
  }
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
    const localRaw = localStorage.getItem(HOSTED_PAYMENT_RECOVERY_STORAGE_KEY);
    const sessionRaw = sessionStorage.getItem(HOSTED_PAYMENT_RECOVERY_STORAGE_KEY);
    const raw = localRaw ?? sessionRaw;
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

    const normalized = normalizeHostedPaymentRecoveryHref(parsed.href, parsed.gateway);
    if (
      !normalized ||
      normalized.gateway !== parsed.gateway ||
      (typeof parsed.orderId === "string" && parsed.orderId !== normalized.orderId)
    ) {
      clearHostedPaymentRecoverySession();
      return null;
    }

    const recovery: HostedPaymentRecoverySession = {
      ...normalized,
      checkoutId: typeof parsed.checkoutId === "string" ? parsed.checkoutId : null,
      cartFingerprint: typeof parsed.cartFingerprint === "string"
        ? parsed.cartFingerprint
        : null,
      createdAt: parsed.createdAt,
    };
    if (!localRaw && sessionRaw) {
      try {
        localStorage.setItem(HOSTED_PAYMENT_RECOVERY_STORAGE_KEY, JSON.stringify(recovery));
        sessionStorage.removeItem(HOSTED_PAYMENT_RECOVERY_STORAGE_KEY);
      } catch {
        // Keep the session copy when durable storage is unavailable.
      }
    }
    return recovery;
  } catch {
    clearHostedPaymentRecoverySession();
    return null;
  }
}
