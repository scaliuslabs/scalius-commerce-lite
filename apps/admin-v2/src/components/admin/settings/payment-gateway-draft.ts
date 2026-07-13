import type { PolarData, SSLCommerzData, StripeData } from "./payment-gateway-utils";

const STRIPE_FIELDS = ["secretKey", "publishableKey", "webhookSecret", "enabled"] as const;
const SSL_COMMERZ_FIELDS = ["storeId", "storePassword", "sandbox", "enabled"] as const;
const POLAR_FIELDS = ["accessToken", "webhookSecret", "productId", "sandbox", "enabled"] as const;

function fieldsEqual<Value extends object>(
  left: Value,
  right: Value | null,
  fields: ReadonlyArray<keyof Value>,
): boolean {
  return Boolean(right) && fields.every((field) => left[field] === right?.[field]);
}

export function stripeDraftIsDirty(draft: StripeData, saved: StripeData | null): boolean {
  return !fieldsEqual(draft, saved, STRIPE_FIELDS);
}

export function sslCommerzDraftIsDirty(draft: SSLCommerzData, saved: SSLCommerzData | null): boolean {
  return !fieldsEqual(draft, saved, SSL_COMMERZ_FIELDS);
}

export function polarDraftIsDirty(draft: PolarData, saved: PolarData | null): boolean {
  return !fieldsEqual(draft, saved, POLAR_FIELDS);
}
