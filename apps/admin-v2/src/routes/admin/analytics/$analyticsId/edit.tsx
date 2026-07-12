import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { AnalyticsForm } from "~/components/admin/AnalyticsForm";
import { analyticsScriptQueryOptions } from "~/lib/api-query-options/analytics";
import type { AnalyticsScript } from "~/types/api-responses";
import { RouteErrorComponent } from "~/lib/route-error";
import { analyticsScriptTypes, type AnalyticsScriptType } from "~/lib/form-schemas";

export const Route = createFileRoute("/admin/analytics/$analyticsId/edit")({
  loader: async ({ context: { queryClient }, params }) => {
    await queryClient.ensureQueryData(analyticsScriptQueryOptions(params.analyticsId));
  },
  head: () => ({ meta: [{ title: "Edit Analytics Script | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: EditAnalyticsPage,
});

function EditAnalyticsPage() {
  const { analyticsId } = Route.useParams();
  const { data } = useSuspenseQuery(analyticsScriptQueryOptions(analyticsId));
  const s = data as AnalyticsScript;

  const validType = (analyticsScriptTypes.includes(s.type as AnalyticsScriptType) ? s.type : "custom") as AnalyticsScriptType;
  const validLocation = (["head", "body_start", "body_end"].includes(s.location) ? s.location : "head") as "head" | "body_start" | "body_end";
  const config = (() => {
    if (validType !== "cloudflare_web_analytics" || !s.config) return s.config || "";
    const match = s.config.match(/data-cf-beacon\s*=\s*(["'])(.*?)\1/is);
    if (!match?.[2]) return s.config;
    try {
      const parsed = JSON.parse(match[2]) as { token?: unknown };
      return typeof parsed.token === "string" ? parsed.token : s.config;
    } catch {
      return s.config;
    }
  })();
  const defaultValues = {
    id: s.id,
    expectedRevision: s.revision,
    name: s.name,
    type: validType,
    isActive: s.isActive,
    usePartytown: s.usePartytown ?? true,
    config,
    location: validLocation,
  };

  return <AnalyticsForm defaultValues={defaultValues} isEdit={true} />;
}
