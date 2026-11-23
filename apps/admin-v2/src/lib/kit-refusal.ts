import { readAdminApiError } from "./admin-api-error";

/**
 * A bundle (kit) or page-offer refusal of any product save (`details.reason`
 * `kit_*` or `page_offer_*`), worded from the dashboard's catalogue; null for
 * any other failure. The catalogue loads only when such a refusal arrives, so
 * the editor's first download never carries it.
 */
export async function readKitRefusal(error: unknown) {
  const reason = (readAdminApiError(error)?.details as { reason?: unknown } | null | undefined)?.reason;
  if (typeof reason !== "string" || !/^(kit|page_offer)_/.test(reason)) return null;
  const { readProductKitRefusal } = await import("~/i18n/product-kit-refusals");
  return readProductKitRefusal(error);
}
