import { createFileRoute } from "@tanstack/react-router";
import { MetaConversionsManager } from "~/components/admin/meta-conversions";
import { getMetaConversionsSettings } from "~/lib/api.functions";

export const Route = createFileRoute("/admin/settings/meta-conversion")({
  loader: async () => {
    const result = await getMetaConversionsSettings().catch(() => ({ settings: null }));
    const r = result as any;
    return { settings: r.settings ?? undefined };
  },
  head: () => ({ meta: [{ title: "Meta Conversions API | Scalius Admin" }] }),
  component: MetaConversionPage,
});

function MetaConversionPage() {
  const { settings } = Route.useLoaderData();

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
      <MetaConversionsManager initialSettings={settings} />
    </div>
  );
}
