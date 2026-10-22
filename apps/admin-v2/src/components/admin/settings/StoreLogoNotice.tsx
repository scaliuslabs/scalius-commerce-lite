import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Alert } from "~/components/ui/alert";
import { useMessages } from "~/i18n";
import { storeSettingsMessages } from "~/i18n/settings-store";
import { themeWorkspaceQueryOptions } from "~/lib/api-query-options/online-store";

/**
 * The store's search details (OnlineStore schema) need the theme's header
 * logo; only a loaded theme without one warns. Loaded after the Store
 * details card, so the theme's query code stays off this page's first render.
 */
export function StoreLogoNotice() {
  const t = useMessages(storeSettingsMessages);
  const { data: workspace } = useQuery({ ...themeWorkspaceQueryOptions(), retry: false });
  if (!workspace || workspace.published.theme.brand?.logo) return null;
  return (
    <Alert variant="warning">
      {t("logoMissingForSearch")}{" "}
      <Link to="/admin/online-store/theme" className="underline">{t("logoMissingAction")}</Link>
    </Alert>
  );
}
