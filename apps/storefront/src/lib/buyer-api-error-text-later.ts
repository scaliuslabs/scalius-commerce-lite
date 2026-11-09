/**
 * `buyerApiErrorText` for a path that needs it only when something failed:
 * the drawer's discount preview and the check of a new app-priced line. The
 * error catalogue (English and Bangla) and its rate-limit wording then load
 * with the failure, not with every first add to cart (the buyer-page budget,
 * `scripts/client-chunk-graph.mjs`). Null when the catalogue cannot load; the
 * caller says its own generic words.
 */
export async function buyerApiErrorTextLater(
  payload: unknown,
  options: { status?: number } = {},
): Promise<string | null> {
  try {
    const { buyerApiErrorText } = await import("./buyer-api-errors");
    return buyerApiErrorText(payload, options);
  } catch {
    return null;
  }
}
