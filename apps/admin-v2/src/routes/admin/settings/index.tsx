import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import GeneralSettingsPage from "~/components/admin/settings/GeneralSettingsPage";
import { generalSettingsQueryOptions } from "~/lib/api-query-options/settings";
import { RouteErrorComponent } from "~/lib/route-error";
import type { HeaderConfig } from "~/components/admin/header-builder/types";
import type { FooterConfig } from "~/components/admin/footer-builder/types";
import type { GeneralSettingsPayload } from "~/lib/api-functions/settings";
import {
  normalizeGeneralSettingsPanel,
  normalizeGeneralSettingsSection,
  type GeneralSettingsPanel,
  type GeneralSettingsSection,
} from "~/components/admin/settings/general-settings-sections";

export function validateGeneralSettingsSearch(search: Record<string, unknown>) {
  const section = normalizeGeneralSettingsSection(search.section);
  const panel = normalizeGeneralSettingsPanel(section, search.panel);
  return panel ? { section, panel } : { section };
}

export const Route = createFileRoute("/admin/settings/")({
  validateSearch: validateGeneralSettingsSearch,
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(generalSettingsQueryOptions());
  },
  head: () => ({ meta: [{ title: "General settings | Scalius Admin" }] }),
  component: SettingsPage,
  errorComponent: RouteErrorComponent,
});

function SettingsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { data } = useSuspenseQuery(generalSettingsQueryOptions());
  const result = data as unknown as GeneralSettingsPayload & {
    headerConfig?: HeaderConfig | null;
    footerConfig?: FooterConfig | null;
  };
  const handleSectionChange = useCallback(
    (section: GeneralSettingsSection) => {
      void navigate({
        search: ((previous: Record<string, unknown>) => ({
          ...previous,
          section,
          panel: normalizeGeneralSettingsPanel(section, undefined),
        })) as never,
      });
    },
    [navigate],
  );
  const handlePanelChange = useCallback(
    (panel: GeneralSettingsPanel) => {
      void navigate({
        search: ((previous: Record<string, unknown>) => ({
          ...previous,
          panel,
        })) as never,
      });
    },
    [navigate],
  );

  return (
    <GeneralSettingsPage
      headerConfig={result.headerConfig ?? null}
      footerConfig={result.footerConfig ?? null}
      headerRevision={result.revisions.header}
      footerRevision={result.revisions.footer}
      headerReadiness={result.navigationReadiness?.header}
      footerReadiness={result.navigationReadiness?.footer}
      panel={search.panel}
      section={search.section}
      onPanelChange={handlePanelChange}
      onSectionChange={handleSectionChange}
    />
  );
}
