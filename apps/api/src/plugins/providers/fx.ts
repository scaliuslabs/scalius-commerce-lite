// An app FX provider as the markets' `FxRateSource` (MARKETS-DESIGN D5;
// packages/plugin-sdk/docs/apps.md, "Providers", fx): the dashboard asks it once when
// the merchant chooses it, and the scheduled tick asks it for every market
// that uses it (`refreshMarketFxRates`). Pages and checkouts read the stored
// rate only.

import { resolveAppProvider, type AppProviders } from "@scalius/core/integrations/provider-port";
import { refreshMarketFxRates, type MarketFxRefreshResult } from "@scalius/core/modules/markets";
import type { Database } from "@scalius/database/client";
import type { FxRateSource } from "@scalius/shared/market-pricing";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { detachedAppProviders } from "./app-providers";

/** The app's rates as a rate source, or the merchant-facing reason it cannot answer. */
export async function appFxRateSource(apps: AppProviders, id: string): Promise<(FxRateSource & { label: string }) | { issue: string }> {
  const choice = await resolveAppProvider(apps, "fx", id);
  if (!choice.provider) return { issue: choice.issue };
  const provider = choice.provider;
  return {
    id,
    label: provider.label,
    async rate(from, to) {
      const answer = await provider.rates({ base: from, quotes: [to] }, {});
      const quote = answer.rates.find((entry) => entry.currency === to);
      return quote ? { rate: quote.rate, asOf: quote.asOf ? new Date(quote.asOf) : null } : null;
    },
  };
}

/** The scheduled refresh of every market whose rate an app sets (one call per market currency). */
export async function refreshAppFxRates(db: Database, env: Env): Promise<MarketFxRefreshResult> {
  let apps: AppProviders | null = null;
  return refreshMarketFxRates(db, async (id) => {
    apps ??= detachedAppProviders(env, db, getCredentialEncryptionKey(env as unknown as Record<string, unknown>));
    const source = await appFxRateSource(apps, id);
    return "issue" in source ? null : source;
  });
}
