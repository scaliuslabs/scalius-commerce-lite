/**
 * The API error catalogue for a path that needs it only when something failed:
 * the drawer's discount preview, the check of a new app-priced line, the cart
 * page's and payment step's refusals. The catalogue (English and Bangla) and
 * its rate-limit wording load with the failure, never with a buyer page's
 * first paint (the buyer-page budgets, `scripts/client-chunk-graph.mjs`).
 */
type Catalogue = typeof import("./buyer-api-errors");

let catalogue: Catalogue | null = null;
let loading: Promise<Catalogue | null> | null = null;

/** The catalogue, loaded once on the first refusal; null when it cannot load (the caller keeps its generic words). */
export function loadBuyerApiErrors(): Promise<Catalogue | null> {
  loading ??= import("./buyer-api-errors").then(
    (module) => (catalogue = module),
    () => {
      loading = null;
      return null;
    },
  );
  return loading;
}

/**
 * The catalogue's words for a refusal if it has loaded, else null: the caller
 * shows its generic line at once and draws these words when
 * `loadBuyerApiErrors()` (started here) settles.
 */
export function buyerApiErrorTextNow(payload: unknown, options: { status?: number } = {}): string | null {
  if (catalogue) return catalogue.buyerApiErrorText(payload, options);
  void loadBuyerApiErrors();
  return null;
}

/** `buyerApiErrorText` once the catalogue has loaded; null when it cannot. */
export async function buyerApiErrorTextLater(
  payload: unknown,
  options: { status?: number } = {},
): Promise<string | null> {
  const loaded = await loadBuyerApiErrors();
  return loaded ? loaded.buyerApiErrorText(payload, options) : null;
}
