import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import GeneralSettingsPage from "~/components/admin/settings/GeneralSettingsPage";
import { generalSettingsQueryOptions } from "~/lib/api-query-options/settings";
import { RouteErrorComponent } from "~/lib/route-error";
import type { HeaderConfig } from "~/components/admin/header-builder/types";
import type { FooterConfig } from "~/components/admin/footer-builder/types";

export const Route = createFileRoute("/admin/settings/")({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(generalSettingsQueryOptions());
  },
  head: () => ({ meta: [{ title: "General Settings | Scalius Admin" }] }),
  component: SettingsPage,
  errorComponent: RouteErrorComponent,
});

function SettingsPage() {
  const { data } = useSuspenseQuery(generalSettingsQueryOptions());
  const result = data as unknown as {
    headerConfig?: HeaderConfig | null;
    footerConfig?: FooterConfig | null;
  };

  return (
    <GeneralSettingsPage
      headerConfig={result.headerConfig ?? null}
      footerConfig={result.footerConfig ?? null}
    />
  );
}
