// Apps in dashboard search (⌘K): an active app by its name (its page), and
// each provider it offers by the provider's name or kind ("Pathao",
// "SMS gateway"), which opens that provider's setup sheet on its capability's
// settings page. App pages come with the navigation. Pure: the dialog maps
// these to its rows.
import { matches, words } from "../settings/settings-search";
import { PROVIDER_CAPABILITY, isAppProviderKind, providerHash, type AppProviderKind } from "./app-capabilities";
import type { AppSurfaces } from "./ui/surfaces";

export interface AppSearchHit {
  id: string;
  kind: "app" | "provider";
  label: string;
  /** The app, and for a provider its kind (to name it "SMS gateway by Bangladesh pack"). */
  app: string;
  providerKind?: AppProviderKind;
  to: string;
  hash?: string;
}

/**
 * Apps and providers matching `query` (every word starts a word of the name,
 * or of the provider's kind label), the ones the staff member may open.
 */
export function searchAppSurfaces(
  apps: readonly AppSurfaces[],
  query: string,
  canOpen: (path: string) => boolean,
  kindLabel: (kind: AppProviderKind) => readonly string[],
): AppSearchHit[] {
  const terms = words(query);
  if (terms.length === 0) return [];
  const hits: AppSearchHit[] = [];
  if (canOpen("/admin/apps")) {
    for (const app of apps) {
      if (matches(terms, words(app.name))) {
        hits.push({ id: `app:${app.id}`, kind: "app", label: app.name, app: app.name, to: `/admin/apps/${encodeURIComponent(app.id)}` });
      }
    }
  }
  for (const app of apps) {
    for (const provider of app.providers) {
      if (!isAppProviderKind(provider.kind)) continue;
      const capability = PROVIDER_CAPABILITY[provider.kind];
      if (!canOpen(capability.to)) continue;
      if (!matches(terms, [...words(provider.name), ...kindLabel(provider.kind).flatMap(words)])) continue;
      hits.push({
        id: `provider:${provider.id}`,
        kind: "provider",
        label: provider.name,
        app: app.name,
        providerKind: provider.kind,
        to: capability.to,
        hash: providerHash(provider.id),
      });
    }
  }
  return hits;
}
