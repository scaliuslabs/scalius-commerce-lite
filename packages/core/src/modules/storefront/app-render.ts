// What drawing apps' storefront output reads first (apps/api
// plugins/storefront-render.ts): the store facts an app's `ctx.store`
// carries and the active installations that draw. The storefront module owns
// these reads (it already reads settings); the plugins module stays a leaf
// that only knows its own tables.

import { safeBatch, type Database } from "@scalius/database/client";
import { checkoutLanguages, type PluginInstallationRow } from "@scalius/database/schema";
import { checkoutLanguageBaseCode } from "@scalius/shared/checkout-language";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { and, eq, isNull } from "drizzle-orm";
import { deps } from "../../cache-deps";
import { activePluginInstallationsFromRows, selectActivePluginInstallations } from "../plugins/storefront";
import type { PluginInstallation } from "../plugins/installations";
import { businessDocument, currencyDocument } from "../settings/documents";
import { platformDocument } from "../platform/document";
import { selectSettingsDocuments, type SettingsDocumentRow } from "../../settings-store";
import { storeDisplayName } from "../settings/store-name";

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

/**
 * What drawing these apps' storefront output reads first, in one batch: the
 * active installations of these ids (`plg:<id>` each) and the store facts.
 */
export async function readPluginRenderContext(db: Database, pluginIds: readonly string[]): Promise<{
  installations: Map<string, PluginInstallation>;
  store: PluginRenderStoreFacts;
}> {
  const facts = planPluginRenderStoreFacts(db);
  const results = await safeBatch(db, [selectActivePluginInstallations(db, pluginIds), ...facts.statements]);
  return {
    installations: activePluginInstallationsFromRows(results[0] as PluginInstallationRow[]),
    store: await facts.resolve(results, 1),
  };
}
