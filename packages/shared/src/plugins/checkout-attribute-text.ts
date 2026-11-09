// An order's app checkout answers as a reader sees them: grouped by app,
// each under the app's label for it and with its value in the reader's
// language (`presentCheckoutAttributes`, beside `presentLineEntry` for line
// entries). The order stores `<app id>.<key>` → value; the words come from the
// app's declaration and its `translations` (through `translationChain()`):
// a declared choice reads its label, a date and a number the reader's format,
// a box "Yes" or "No" and an upload its file count from the checkout
// catalogue (`LineEntryWords`). Browser-safe and free of I/O: the dashboard,
// the storefront, emails and invoices share it.
import { parseBuyerUploadValue } from "../buyer-uploads";
import { formatNumber, numberLocale } from "../locale-format";
import { formatAttributeDate } from "./checkout-attribute-values";
export { formatAttributeDate };
import type { LineEntryWords } from "../line-entry-words";
import type { CheckoutAttribute } from "./buyer-ui";
import { localizedAppName, localizedCheckoutAttributes, pluginTextChain } from "./manifest-text";
import type { PluginTranslation } from "./manifest";

/** What a reader needs of an app to word its answers: its name, its declared attributes and their translations. */
export interface CheckoutAttributeApp {
  appId: string;
  name: string;
  attributes: CheckoutAttribute[];
  translations?: Record<string, PluginTranslation>;
}

/** Who reads: their language and the store's (the fallback), the catalogue's words and the store's country. */
export interface CheckoutAttributeReader {
  locale: string;
  defaultLocale: string;
  words: LineEntryWords;
  /** The store's country: lakh grouping in Bangladesh. */
  region?: string | null;
}

export interface PresentedCheckoutAttribute {
  /** The attribute key within its app. */
  key: string;
  label: string;
  value: string;
  /** An upload's ids, for a surface that lists the files; absent otherwise. */
  uploads?: string;
}

export interface PresentedCheckoutAttributeGroup {
  appId: string;
  appName: string;
  entries: PresentedCheckoutAttribute[];
}

function presentValue(attribute: CheckoutAttribute | undefined, value: string, reader: CheckoutAttributeReader): { value: string; uploads?: string } {
  switch (attribute?.type) {
    case "choice": return { value: attribute.choices?.find((choice) => choice.value === value)?.label ?? value };
    case "boolean": return { value: value === "true" ? reader.words.lineCheckedText : value === "false" ? reader.words.lineUncheckedText : value };
    case "date": return { value: formatAttributeDate(value, reader.locale, reader.region) };
    case "number": {
      const number = Number(value);
      return { value: value.trim() !== "" && Number.isFinite(number) ? formatNumber(number, numberLocale(reader.locale, reader.region)) : value };
    }
    case "file": {
      const ids = parseBuyerUploadValue(value, attribute.maxFiles ?? 10);
      if (!ids) return { value };
      const count = formatNumber(ids.length, numberLocale(reader.locale, reader.region));
      return { value: ids.length === 1 ? reader.words.lineOneFileText : reader.words.lineFilesText.replace("{count}", count), uploads: value };
    }
    default: return { value };
  }
}

/**
 * The answers, by app in the order they were stored, each in the reader's
 * language. An app the store no longer has keeps its id as its name and each
 * answer its key and stored value: nothing is dropped.
 */
export function presentCheckoutAttributes(
  values: Readonly<Record<string, string>>,
  apps: readonly CheckoutAttributeApp[],
  reader: CheckoutAttributeReader,
): PresentedCheckoutAttributeGroup[] {
  const byId = new Map(apps.map((app) => [app.appId, app]));
  const groups = new Map<string, PresentedCheckoutAttributeGroup>();
  const words = new Map<string, { name: string; attributes: CheckoutAttribute[] }>();
  for (const [name, value] of Object.entries(values)) {
    const boundary = name.lastIndexOf(".");
    if (boundary < 1 || value === "") continue;
    const appId = name.slice(0, boundary);
    const key = name.slice(boundary + 1);
    let app = words.get(appId);
    if (!app) {
      const declared = byId.get(appId);
      const chain = declared ? pluginTextChain(declared.translations, reader) : [];
      app = declared
        ? { name: localizedAppName(declared.name, chain), attributes: localizedCheckoutAttributes(declared.attributes, chain) }
        : { name: appId, attributes: [] };
      words.set(appId, app);
    }
    const attribute = app.attributes.find((field) => field.key === key);
    const group = groups.get(appId) ?? { appId, appName: app.name, entries: [] };
    group.entries.push({ key, label: attribute?.label ?? key, ...presentValue(attribute, value, reader) });
    groups.set(appId, group);
  }
  return [...groups.values()];
}

/** "Delivery day: 10 Nov 2026" lines, for plain text (emails). */
export function checkoutAttributeLines(groups: readonly PresentedCheckoutAttributeGroup[]): string[] {
  return groups.flatMap((group) => group.entries.map((entry) => `${entry.label}: ${entry.value}`));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * An app's words for its checkout answers from its stored manifest JSON (an
 * installation's `manifest_json`, validated when it was installed): its name,
 * its declared attributes and only their translations. Null when unreadable.
 */
export function checkoutAttributeAppFromManifest(appId: string, manifestJson: string | null | undefined): CheckoutAttributeApp | null {
  let manifest: unknown;
  try { manifest = manifestJson ? JSON.parse(manifestJson) : null; } catch { return null; }
  if (!isRecord(manifest) || typeof manifest.name !== "string") return null;
  const checkout = isRecord(manifest.checkout) ? manifest.checkout : {};
  const attributes = (Array.isArray(checkout.attributes) ? checkout.attributes : [])
    .filter((field): field is CheckoutAttribute => isRecord(field) && typeof field.key === "string" && typeof field.label === "string" && typeof field.type === "string");
  const translations: Record<string, PluginTranslation> = {};
  for (const [tag, text] of Object.entries(isRecord(manifest.translations) ? manifest.translations : {})) {
    if (!isRecord(text)) continue;
    const own = isRecord(text.checkout) && isRecord(text.checkout.attributes) ? text.checkout.attributes : null;
    translations[tag] = {
      ...(typeof text.name === "string" ? { name: text.name } : {}),
      ...(own ? { checkout: { attributes: own as NonNullable<NonNullable<PluginTranslation["checkout"]>["attributes"]> } } : {}),
    };
  }
  return { appId, name: manifest.name, attributes, ...(Object.keys(translations).length > 0 ? { translations } : {}) };
}
