// Storefront reads of the plugin tables (docs/platform/PLUGINS.md,
// "Storefront surfaces"): the active installations a public render needs (to
// draw app sections and blocks, and to load the scripts of active apps), as
// batch statements, each declaring the keys the plugin module's writes
// advance (cache-deps.ts). Inactive, ungranted or unparseable installations
// are never returned: they draw nothing and load nothing.

import { safeBatch, type Database } from "@scalius/database/client";
import { checkoutLanguages, pluginInstallations, type PluginInstallationRow } from "@scalius/database/schema";
import { checkoutLanguageBaseCode } from "@scalius/shared/checkout-language";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { deps } from "../../cache-deps";
import { storeDisplayName } from "../notifications/store-messages";
import { businessDocument, currencyDocument, platformDocument } from "../settings/documents";
import { selectSettingsDocuments, type SettingsDocumentRow } from "../settings/settings-store";
import { toPluginInstallation, type PluginInstallation } from "./installations";

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
 * active checkout language (one batch).
 */
export async function readPluginRenderStoreFacts(db: Database): Promise<PluginRenderStoreFacts> {
  deps.checkoutLanguages();
  const [documentRows, languageRows] = await safeBatch(db, [
    selectSettingsDocuments(db, [businessDocument, platformDocument, currencyDocument]),
    db.select({ code: checkoutLanguages.code }).from(checkoutLanguages)
      .where(and(eq(checkoutLanguages.isActive, true), isNull(checkoutLanguages.deletedAt)))
      .limit(1),
  ]);
  const rows = documentRows as SettingsDocumentRow[];
  const [business, platform, currency] = await Promise.all([
    businessDocument.fromRows(rows),
    platformDocument.fromRows(rows),
    currencyDocument.fromRows(rows),
  ]);
  const language = checkoutLanguageBaseCode((languageRows as Array<{ code: string }>)[0]?.code) === "bn" ? "bn-BD" : "en";
  return {
    name: storeDisplayName(business.value, platform.value.storefrontUrl) ?? "",
    currency: currency.value.currencyCode,
    decimalPlaces: getDecimalPlaces(currency.value.currencyCode),
    locale: language,
  };
}

/**
 * One statement: the active installations, all of them or these ids.
 * Declares `plg:*` for the full list (which apps are active) and `plg:<id>`
 * for each named id (activation, settings, version and removal of each).
 */
export function selectActivePluginInstallations(db: Database, pluginIds?: readonly string[]) {
  if (pluginIds) for (const id of pluginIds) deps.plugin(id);
  else deps.anyPlugin();
  const ids = pluginIds ? [...new Set(pluginIds)] : null;
  return db.select().from(pluginInstallations)
    .where(and(
      eq(pluginInstallations.status, "active"),
      ids ? sql`${pluginInstallations.pluginId} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)}))` : undefined,
    ))
    .orderBy(asc(pluginInstallations.pluginId));
}

/** Active, approved and parseable installations from those rows, by plugin id. */
export function activePluginInstallationsFromRows(rows: readonly PluginInstallationRow[]): Map<string, PluginInstallation> {
  const installations = new Map<string, PluginInstallation>();
  for (const row of rows) {
    const installation = toPluginInstallation(row);
    if (installation && installation.status === "active" && installation.grant) installations.set(installation.pluginId, installation);
  }
  return installations;
}

/** The pages a storefront script may load on (`storefront.scripts[].pages`). */
export type PluginScriptPage = "all" | "home" | "product" | "listing" | "cart" | "checkout" | "order-success";

export interface PluginStorefrontScript {
  pluginId: string;
  src: string;
  placement: "head" | "body-end";
  pages: PluginScriptPage[];
}

/**
 * The storefront scripts of active apps, only those whose host the approved
 * grant covers (an update that adds a host loads nothing new until it is
 * approved), in plugin id then manifest order.
 */
export function activePluginStorefrontScripts(installations: Iterable<PluginInstallation>): PluginStorefrontScript[] {
  const scripts: PluginStorefrontScript[] = [];
  for (const installation of installations) {
    const granted = new Set(installation.grant?.storefrontScripts ?? []);
    for (const script of installation.manifest.storefront.scripts) {
      let host: string;
      try {
        const url = new URL(script.src);
        if (url.protocol !== "https:") continue;
        host = url.host;
      } catch {
        continue;
      }
      if (!granted.has(host)) continue;
      scripts.push({ pluginId: installation.pluginId, src: script.src, placement: script.placement, pages: [...script.pages] });
    }
  }
  return scripts.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}
