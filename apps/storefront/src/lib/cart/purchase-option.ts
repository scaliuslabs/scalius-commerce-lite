// A cart line's purchase options: the apps' ways to buy it (a subscription,
// a rental, another app's protection plan; manifest `checkout.purchaseOptions`),
// at most one of each app, sorted by id. The ids are part of the line's
// identity (the same SKU one-time and under an option are two lines) and
// travel in request bodies as the line's `purchaseOptions`; the titles are
// what the buyer chose, for display. The apps price the line at checkout.
import { LINE_PURCHASE_OPTIONS_MAX, normalizeLinePurchaseOptions } from "@scalius/shared/line-properties";
import { isPurchaseOptionId, purchaseOptionAppId } from "@scalius/shared/plugins/ids";

export type CartLinePurchaseOption = {
  /** `<app id>.<key>`. */
  id: string;
  /** "Subscribe and save" (display only). */
  title: string;
};

/** The longest title kept (the manifest's limit). */
const MAX_PURCHASE_OPTION_TITLE_LENGTH = 80;

/**
 * A stored or answered option: undefined for none, null when it is malformed
 * (a line whose identity can't be trusted is dropped, never re-keyed).
 */
export function normalizeCartLinePurchaseOption(value: unknown): CartLinePurchaseOption | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const { id, title } = value as { id?: unknown; title?: unknown };
  if (!isPurchaseOptionId(id)) return null;
  const text = typeof title === "string" ? Array.from(title.normalize("NFC").trim()).slice(0, MAX_PURCHASE_OPTION_TITLE_LENGTH).join("") : "";
  return { id, title: text || id };
}

/**
 * A stored or answered list of options (`purchaseOptions`), sorted by id:
 * `[]` for none, null when any entry is malformed, two are of one app or
 * there are too many (the line is dropped, never re-keyed). `legacy` is the
 * single `purchaseOption` a cart saved before a line could carry one option
 * per app; it is read only when there is no list.
 */
export function normalizeCartLinePurchaseOptions(value: unknown, legacy?: unknown): CartLinePurchaseOption[] | null {
  if (value === undefined || value === null) {
    const single = normalizeCartLinePurchaseOption(legacy);
    return single === null ? null : single ? [single] : [];
  }
  if (!Array.isArray(value) || value.length > LINE_PURCHASE_OPTIONS_MAX) return null;
  const options: CartLinePurchaseOption[] = [];
  for (const entry of value) {
    const option = normalizeCartLinePurchaseOption(entry);
    if (!option) return null;
    options.push(option);
  }
  return oneOptionPerApp(options);
}

/** The options sorted by id, or null when two are of one app (repeats of one option count once). */
function oneOptionPerApp(options: readonly CartLinePurchaseOption[]): CartLinePurchaseOption[] | null {
  const byId = new Map(options.map((option) => [option.id, option]));
  const apps = new Set<string>();
  for (const id of byId.keys()) {
    const app = purchaseOptionAppId(id)!;
    if (apps.has(app)) return null;
    apps.add(app);
  }
  return [...byId.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/**
 * The ids a line sends (`purchaseOptions`), sorted, from a cart line's
 * options (`{ id, title }` or ids), or from the single `purchaseOption` of a
 * line saved before; `[]` for none, null when they are malformed.
 */
export function cartLinePurchaseOptionIds(line: { purchaseOptions?: unknown; purchaseOption?: unknown }): string[] | null {
  const list = line.purchaseOptions;
  const entries = list === undefined || list === null
    ? (line.purchaseOption === undefined || line.purchaseOption === null ? [] : [line.purchaseOption])
    : Array.isArray(list) ? list : null;
  if (!entries) return null;
  const ids = entries.map((entry) => isPurchaseOptionId(entry)
    ? entry
    : typeof entry === "object" && entry !== null && isPurchaseOptionId((entry as { id?: unknown }).id)
      ? (entry as { id: string }).id
      : null);
  if (ids.some((id) => id === null)) return null;
  const normalized = normalizeLinePurchaseOptions(ids);
  return normalized.ok ? normalized.options : null;
}

/**
 * The line's `purchaseOptions` field for a request body: absent for a
 * one-time line (and for malformed options, which the caller checked or
 * the store's cart already dropped).
 */
export function purchaseOptionsField(line: { purchaseOptions?: unknown; purchaseOption?: unknown }): { purchaseOptions?: string[] } {
  const ids = cartLinePurchaseOptionIds(line);
  return ids && ids.length > 0 ? { purchaseOptions: ids } : {};
}
