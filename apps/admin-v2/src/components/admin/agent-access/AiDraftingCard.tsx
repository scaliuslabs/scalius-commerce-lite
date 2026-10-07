/**
 * Settings → Integrations → Drafting with AI: the AI providers of installed
 * apps, which add "Draft with AI" to the theme editor (none is built in, and
 * Scalius holds no model key). Without one, the card says how to get one.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AppProviderStatus } from "~/components/admin/settings/AppProviderStatus";
import { SettingsCard } from "~/components/admin/settings/SettingsPage";
import { useMessages } from "~/i18n";
import { aiAccessMessages } from "~/i18n/settings-ai-access";
import { appProvidersQuery } from "~/lib/api-query-options/settings-screens";

export function AiDraftingCard() {
  const t = useMessages(aiAccessMessages);
  const providers = useQuery(appProvidersQuery("ai"));
  return (
    <SettingsCard id="aiDrafting" title={t("draftingTitle")} description={t("draftingDescription")}>
      {providers.data && providers.data.length > 0 ? (
        <div className="flex flex-col gap-4">
          {providers.data.map((provider) => <AppProviderStatus key={provider.id} provider={provider} />)}
        </div>
      ) : providers.isPending ? null : (
        <p className="text-body text-muted-foreground">
          {t("draftingEmpty")} <Link to="/admin/apps" className="text-link hover:underline">{t("draftingBrowse")}</Link>
        </p>
      )}
    </SettingsCard>
  );
}
