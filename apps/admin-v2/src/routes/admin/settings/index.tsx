import { createFileRoute } from "@tanstack/react-router";
import GeneralSettingsPage from "~/components/admin/settings/GeneralSettingsPage";
import { getGeneralSettings } from "~/lib/api.functions";

export const Route = createFileRoute("/admin/settings/")({
  loader: async () => {
    const result = await getGeneralSettings().catch(() => ({ headerConfig: null, footerConfig: null }));
    const r = result as any;
    return {
      headerConfig: r.headerConfig || null,
      footerConfig: r.footerConfig || null,
    };
  },
  head: () => ({ meta: [{ title: "General Settings | Scalius Admin" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const { headerConfig, footerConfig } = Route.useLoaderData();

  return (
    <GeneralSettingsPage
      headerConfig={headerConfig}
      footerConfig={footerConfig}
    />
  );
}
