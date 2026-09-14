import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { MetaConversionsManager } from "~/components/admin/meta-conversions";
import { SettingsLayout } from "~/components/admin/settings/SettingsLayout";
import {
  normalizeMetaConversionsWorkspaceSection,
  type MetaConversionsWorkspaceSection,
} from "~/components/admin/meta-conversions/meta-conversions-workspace";
import { metaConversionsSettingsQueryOptions } from "~/lib/api-query-options/settings";
import type { MetaConversionsSettingsResponse } from "~/types/api-responses";
import { RouteErrorComponent } from "~/lib/route-error";
import { useWorkspaceScrollMemory } from "~/hooks/use-workspace-scroll-memory";

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
  const rememberWorkspaceScroll = useWorkspaceScrollMemory(search.section);
  const handleSectionChange = useCallback(
    (section: MetaConversionsWorkspaceSection) => {
      void navigate({
        resetScroll: false,
        search: ((previous: Record<string, unknown>) => ({
          ...previous,
          section,
        })) as never,
      });
    },
    [navigate],
  );

  return (
    <div
      className="contents"
      onPointerDownCapture={rememberWorkspaceScroll}
      onKeyDownCapture={rememberWorkspaceScroll}
    >
      <SettingsLayout
        pathname="/admin/settings/meta-conversion"
        title="Meta conversions"
        description="Server-side events sent to Meta, and the delivery results returned."
      >
      <MetaConversionsManager
        initialSettings={r.settings ?? undefined}
        initialPixelParity={r.pixelParity}
        section={search.section}
        onSectionChange={handleSectionChange}
      />
      </SettingsLayout>
    </div>
  );
}
