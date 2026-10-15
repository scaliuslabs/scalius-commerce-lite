// Store facts for app handlers and buyer-facing services. Reads are planned
// here so callers can include them in their existing batch.

import type { Database } from "@scalius/database/client";
import { checkoutLanguages } from "@scalius/database/schema";
import { checkoutLanguageBaseCode } from "@scalius/shared/checkout-language";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { and, eq, isNull } from "drizzle-orm";
import { deps } from "../../cache-deps";
import type { PluginInstallation } from "../plugins";
import { businessDocument, currencyDocument, storeDisplayName } from "../settings";
import { platformDocument } from "../platform";
import { selectSettingsDocuments, type SettingsDocumentRow } from "../../settings-store";

/** The store facts a storefront render's `ctx.store` carries. */
export interface PluginRenderStoreFacts {
  name: string;
  currency: string;
  decimalPlaces: number;
  locale: string;
}

/**
 * `ctx.store` for storefront renders, from exactly the rows whose keys the
 * render declares: the business, platform and currency documents and the
 * active checkout language. Two statements a caller puts into the batch it
 * already sends, so drawing an app costs no round trip of its own.
 */
export function planPluginRenderStoreFacts(db: Database) {
  deps.checkoutLanguages();
  const statements = [
    selectSettingsDocuments(db, [businessDocument, platformDocument, currencyDocument]),
    db.select({ code: checkoutLanguages.code }).from(checkoutLanguages)
      .where(and(eq(checkoutLanguages.isActive, true), isNull(checkoutLanguages.deletedAt)))
      .limit(1),
  ] as const;
  return {
    statements,
    async resolve(results: readonly unknown[], offset: number): Promise<PluginRenderStoreFacts> {
      const rows = results[offset] as SettingsDocumentRow[];
      const [business, platform, currency] = await Promise.all([
        businessDocument.fromRows(rows),
        platformDocument.fromRows(rows),
        currencyDocument.fromRows(rows),
      ]);
      const language = checkoutLanguageBaseCode((results[offset + 1] as Array<{ code: string }>)[0]?.code) === "bn" ? "bn-BD" : "en";
      return {
        name: storeDisplayName(business.value, platform.value.storefrontUrl) ?? "",
        currency: currency.value.currencyCode,
        decimalPlaces: getDecimalPlaces(currency.value.currencyCode),
        locale: language,
      };
    },
  };
}
/** The buyer-facing services active apps provide, as the layout tells the storefront. */
export interface PluginStorefrontServices {
  /** The search app that ranks predictive search (`<plugin id>:<provider id>`), or null for built-in search. */
  search: string | null;
  /** The address autocomplete app at checkout, with the countries it knows. */
  address: { id: string; countries: "any" | string[] } | null;
  /** Sign-in apps the sign-in page offers ("Continue with …"), in app id order. */
  signIn: Array<{ id: string; name: string }>;
}

/**
 * Which buyer services active apps approved for those ports provide, from
 * active installations already read (no read of its own). The first app by
 * id answers search and address; every sign-in app is offered. Readiness
 * (settings) is checked where the service is used: search then falls back
 * to built-in search, address gives no suggestions, sign-in returns to the
 * sign-in page.
 */
export function activePluginStorefrontServices(installations: Iterable<PluginInstallation>): PluginStorefrontServices {
  const services: PluginStorefrontServices = { search: null, address: null, signIn: [] };
  const sorted = [...installations].sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  for (const installation of sorted) {
    const approved = installation.grant?.providers ?? [];
    for (const provider of installation.manifest.providers) {
      if (!approved.includes(provider.kind)) continue;
      const id = `${installation.pluginId}:${provider.id}`;
      if (provider.kind === "search") services.search ??= id;
      else if (provider.kind === "address") services.address ??= { id, countries: provider.countries === "any" ? "any" : [...provider.countries] };
      else if (provider.kind === "identity" && services.signIn.length < 6) services.signIn.push({ id, name: provider.name });
    }
  }
  return services;
}
