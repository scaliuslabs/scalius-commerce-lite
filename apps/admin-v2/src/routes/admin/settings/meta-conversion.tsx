import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { MetaConversionsManager } from "~/components/admin/meta-conversions";
import {
  normalizeMetaConversionsWorkspaceSection,
  type MetaConversionsWorkspaceSection,
} from "~/components/admin/meta-conversions/meta-conversions-workspace";
import { metaConversionsSettingsQueryOptions } from "~/lib/api-query-options/settings";
import type { MetaConversionsSettingsResponse } from "~/types/api-responses";
import { RouteErrorComponent } from "~/lib/route-error";

export function validateMetaConversionsSearch(search: Record<string, unknown>) {
  return { section: normalizeMetaConversionsWorkspaceSection(search.section) };
}

export const Route = createFileRoute("/admin/settings/meta-conversion")({
  validateSearch: validateMetaConversionsSearch,
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(metaConversionsSettingsQueryOptions());
  },
  head: () => ({ meta: [{ title: "Meta Conversions API | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: MetaConversionPage,
});

function MetaConversionPage() {
  const { data } = useSuspenseQuery(metaConversionsSettingsQueryOptions());
  const search = Route.useSearch();
  const navigate = useNavigate();
  const r = data as unknown as MetaConversionsSettingsResponse;
  const handleSectionChange = useCallback(
    (section: MetaConversionsWorkspaceSection) => {
      void navigate({
        search: ((previous: Record<string, unknown>) => ({
          ...previous,
          section,
        })) as never,
      });
    },
    [navigate],
  );

  return (
    <div className="container max-w-6xl space-y-4 py-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Meta conversions</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Server events and delivery results.
        </p>
      </div>
      <MetaConversionsManager
        initialSettings={r.settings ?? undefined}
        initialPixelParity={r.pixelParity}
        section={search.section}
        onSectionChange={handleSectionChange}
      />
    </div>
  );
}
