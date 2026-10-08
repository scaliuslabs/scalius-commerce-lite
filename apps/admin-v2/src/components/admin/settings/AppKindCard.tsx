/**
 * The settings card of an app provider kind that has no built-in choice list:
 * chat apps (Notifications), exchange rates (Markets), address autocomplete
 * (Checkout), sign-in with other accounts (Customer accounts) and search
 * (Integrations). It lists the installed apps' providers of the kind, each with
 * its readiness and its setup sheet, or says in one line that none is
 * installed. Same pattern as the machine translation and AI drafting cards.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useMessages } from "~/i18n";
import { appKindsMessages } from "~/i18n/settings-app-kinds";
import { useProviderPortAccess } from "~/lib/provider-port-access";
import { appProvidersQuery, type AppProviderKind } from "~/lib/api-query-options/settings-screens";
import { AppProviderStatus } from "./AppProviderStatus";
import { SettingsCard } from "./SettingsPage";
import type { SettingsCardId } from "./settings-search";

type KindMessage = keyof (typeof appKindsMessages)["en"];

export const APP_KIND_CARDS = {
  messaging: { id: "chatApps", title: "chatTitle", description: "chatDescription", empty: "chatEmpty" },
  fx: { id: "exchangeRates", title: "ratesTitle", description: "ratesDescription", empty: "ratesEmpty" },
  address: { id: "addressAutocomplete", title: "addressTitle", description: "addressDescription", empty: "addressEmpty" },
  identity: { id: "otherSignIn", title: "signInTitle", description: "signInDescription", empty: "signInEmpty" },
  search: { id: "appSearch", title: "searchTitle", description: "searchDescription", empty: "searchEmpty" },
} as const satisfies Partial<Record<AppProviderKind, { id: SettingsCardId; title: KindMessage; description: KindMessage; empty: KindMessage }>>;

/** One line under a card: no app of this kind, and where to find one. */
export function NoAppsLine({ children }: { children: ReactNode }) {
  const t = useMessages(appKindsMessages);
  return (
    <p className="text-body text-muted-foreground">
      {children} <Link to="/admin/apps" className="text-link hover:underline">{t("browseApps")}</Link>
    </p>
  );
}

export function AppKindCard({ kind }: { kind: keyof typeof APP_KIND_CARDS }) {
  const t = useMessages(appKindsMessages);
  const card = APP_KIND_CARDS[kind];
  const { canView } = useProviderPortAccess(kind);
  const providers = useQuery({ ...appProvidersQuery(kind), enabled: canView });
  // Cards hide themselves for roles that cannot read their providers.
  if (!canView) return null;
  return (
    <SettingsCard id={card.id} title={t(card.title)} description={t(card.description)}>
      {providers.data && providers.data.length > 0 ? (
        <div className="flex flex-col gap-4">
          {providers.data.map((provider) => <AppProviderStatus key={provider.id} provider={provider} />)}
        </div>
      ) : providers.isPending ? null : (
        <NoAppsLine>{t(card.empty)}</NoAppsLine>
      )}
    </SettingsCard>
  );
}
