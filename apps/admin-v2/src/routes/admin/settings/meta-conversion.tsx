import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { MetaConversionsManager } from "~/components/admin/meta-conversions";
import { metaConversionsSettingsQueryOptions } from "~/lib/api-query-options/settings";
import type { MetaConversionsSettingsResponse } from "~/types/api-responses";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/meta-conversion")({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(metaConversionsSettingsQueryOptions());
  },
  head: () => ({ meta: [{ title: "Meta Conversions API | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: MetaConversionPage,
});

function MetaConversionPage() {
  const { data } = useSuspenseQuery(metaConversionsSettingsQueryOptions());
  const r = data as unknown as MetaConversionsSettingsResponse;

  return (
    <div className="container py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Meta Conversions API</h1>
          <p className="text-muted-foreground">
            Configure and monitor your Meta (Facebook) Conversions API integration
            for improved tracking and attribution.
          </p>
        </div>
      </div>
      <MetaConversionsManager initialSettings={r.settings ?? undefined} />
    </div>
  );
}
