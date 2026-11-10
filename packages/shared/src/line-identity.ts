/**
 * A cart line's identity: its canonical buyer inputs and purchase options,
 * hashed into the line key the storefront's cart and the API share, and the
 * bounds of what a line carries. Only what a product page's cart needs, with
 * no schema or validation code (`line-properties.ts` re-exports it all), so a
 * buyer page downloads none of the buyer-input resolution.
 *
 * Properties are buyer content: never put them in URLs, analytics, logs or
 * queue payloads.
 */
import { sha256Hex } from "./hash";
import { appScopedKeyAppId, isAppScopedKey } from "./plugins/ids";

export const LINE_PROPERTY_INPUT_LIMITS = {
  /** The product's own inputs (at most 10) and the active apps' line inputs, together. */
  entries: 40,
  valueLength: 1_000,
  /**
   * A line's resolved answers, serialized as the order line stores them. A
   * text answer is stored twice (value and what the buyer saw), so 40 long
   * answers would outgrow the stored snapshot (`ORDER_LINE_PROPERTIES_MAX_LENGTH`);
   * the rest of the snapshot is left for what checkout freezes beside them
   * (the apps' add-ons, options and a bundle).
   */
  serializedLength: 49_152,
} as const;

export const NO_PROPERTIES_HASH = "none" as const;

export interface LinePropertyInput {
  key: string;
  value: string;
  /**
   * The revision of the input's words the buyer answered (an app input's
   * `textRevision`, as the page drew it). Not part of the line's identity:
   * the same answer to newer words is the same line. Absent: unknown.
   */
  revision?: string;
}

/** A recorded answer revision: what `lineInputTextRevision` makes, kept short and plain. */
export const LINE_PROPERTY_REVISION_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The identity form of a line's properties: schema keys, schema order, no empties. */
export interface CanonicalLineProperty {
  key: string;
  value: string;
}

/** The key of a purchase option's entry on an order line (`linePurchaseOptionProperty` in line-properties.ts). */
export const LINE_PURCHASE_OPTION_PROPERTY_KEY = "_purchase_option";
/**
 * The entry keys the platform freezes beside the buyer's inputs: an app's
 * add-on and a bundle. Here, in a module that imports nothing heavy, because
 * the cart store (on every buyer page's first paint) names the add-on's key;
 * line-entry-words.ts, which words them, pulls in the upload parser.
 */
export const LINE_ADJUSTMENT_KEY = "_adjustment";
export const LINE_BUNDLE_KEY = "_bundle";
/** The most purchase options one line carries (one per app). */
export const LINE_PURCHASE_OPTIONS_MAX = 5;

export type LinePurchaseOptionsResult =
  | { ok: true; options: string[] }
  | { ok: false; reason: "invalid" | "same_app" | "too_many"; option: string | null };

/**
 * A line's purchase options in their one canonical form: valid ids, at most
 * one per app (two from one app are refused, never chosen between), at most
 * LINE_PURCHASE_OPTIONS_MAX, sorted by id. Absent, null or empty is none.
 */
export function normalizeLinePurchaseOptions(value: unknown): LinePurchaseOptionsResult {
  if (value === undefined || value === null) return { ok: true, options: [] };
  if (!Array.isArray(value)) return { ok: false, reason: "invalid", option: null };
  const apps = new Set<string>();
  const options = new Set<string>();
  for (const entry of value) {
    if (!isAppScopedKey(entry)) return { ok: false, reason: "invalid", option: typeof entry === "string" ? entry.slice(0, 160) : null };
    if (options.has(entry)) continue;
    const appId = appScopedKeyAppId(entry)!;
    if (apps.has(appId)) return { ok: false, reason: "same_app", option: entry };
    apps.add(appId);
    options.add(entry);
  }
  if (options.size > LINE_PURCHASE_OPTIONS_MAX) return { ok: false, reason: "too_many", option: null };
  return { ok: true, options: [...options].sort() };
}

/**
 * What a cart line's identity hashes (`linePropertiesHash`, `lineCartKey`):
 * its canonical buyer inputs, then one entry per purchase option, sorted by
 * id. A line with one option hashes exactly as it did when a line could have
 * only one; a line with none exactly as one without options.
 */
export function lineIdentityProperties(
  canonical: readonly CanonicalLineProperty[],
  purchaseOptions: readonly string[] | null | undefined,
): CanonicalLineProperty[] {
  const options = [...new Set(purchaseOptions ?? [])].filter(Boolean).sort();
  return [...canonical, ...options.map((value) => ({ key: LINE_PURCHASE_OPTION_PROPERTY_KEY, value }))];
}

/**
 * `sha256(canonical JSON)`, first 16 hex characters, or "none" without
 * properties. Identical canonical properties always hash the same.
 */
export async function linePropertiesHash(canonical: readonly CanonicalLineProperty[]): Promise<string> {
  if (canonical.length === 0) return NO_PROPERTIES_HASH;
  const payload = JSON.stringify(canonical.map((property) => [property.key, property.value]));
  return (await sha256Hex(payload)).slice(0, 16);
}

/** `line:v3:<product>:variant:<variant>:p:<propertiesHash>` — same SKU + same properties = one line. */
export function lineCartKey(productId: string, variantId: string, propertiesHash: string): string {
  return `line:v3:${productId}:variant:${variantId}:p:${propertiesHash}`;
}
