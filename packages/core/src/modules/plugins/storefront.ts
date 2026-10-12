// Storefront reads of the plugin tables (docs/platform/PLUGINS.md,
// "Storefront surfaces"): the active installations a public render needs (to
// draw app sections and blocks, and to load the scripts of active apps), as
// batch statements, each declaring the keys the generated triggers on the
// plugin tables advance (migration 0110). Inactive, ungranted or unparseable installations
// are never returned: they draw nothing and load nothing.

import type { Database } from "@scalius/database/client";
import { pluginInstallations, type PluginInstallationRow } from "@scalius/database/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import { deps } from "../../cache-deps";
import { pluginHasStorefrontModule, type StorefrontExtension } from "@scalius/shared/plugins";
import { toPluginInstallation, type PluginInstallation } from "./installations";

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

/**
 * Active apps with storefront components, as the layout payload lists them
 * (`appExtensions`, `StorefrontExtension`): their release, the component
 * sections and slots their storefront module draws (with the settings
 * schemas the storefront resolves), islands, stylesheet and browser hosts.
 * An app whose approved grant does not cover storefront code (approved
 * before it asked) is left out until a Super Admin approves the update.
 */
export function activePluginStorefrontExtensions(installations: Iterable<PluginInstallation>): StorefrontExtension[] {
  const extensions: StorefrontExtension[] = [];
  for (const installation of installations) {
    const storefront = installation.manifest.storefront;
    const ships = pluginHasStorefrontModule(storefront) || storefront.islands.length > 0 || storefront.stylesheet;
    if (!ships || installation.grant?.storefrontCode !== true) continue;
    const granted = new Set(installation.grant.storefrontConnect ?? []);
    extensions.push({
      pluginId: installation.pluginId,
      version: installation.version,
      source: installation.source,
      release: installation.bundleSha256,
      sections: storefront.sections.filter((section) => section.route === undefined).map((section) => section.type),
      sectionSettings: Object.fromEntries(storefront.sections.filter((section) => section.route === undefined).map((section) => [section.type, section.settings])),
      slots: storefront.slots.map((slot) => ({ id: slot.id, slot: slot.slot, settings: slot.settings })),
      islands: storefront.islands.map((island) => island.name),
      stylesheet: storefront.stylesheet,
      connect: storefront.connect.filter((host) => granted.has(host)),
    });
  }
  return extensions.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}
