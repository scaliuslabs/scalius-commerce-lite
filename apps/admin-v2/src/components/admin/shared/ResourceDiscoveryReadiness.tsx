import { useQuery } from "@tanstack/react-query";
import {
  Braces,
  Globe2,
  Link2,
  SearchCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { DEFAULT_SEO_DISCOVERY_SETTINGS } from "@scalius/shared/seo-discovery";
import { Badge } from "@/components/ui/badge";
import { useStorefrontUrl } from "@/hooks/use-storefront-url";
import { seoSettingsQueryOptions } from "@/lib/api-query-options/settings";
import {
  buildResourceDiscoveryPreview,
  type ResourceDiscoveryPreviewInput,
  type ResourceDiscoveryRow,
  type ResourceDiscoveryTone,
} from "@/lib/resource-seo-discovery-preview";

const TONE_LABELS: Record<ResourceDiscoveryTone, string> = {
  ok: "Ready",
  warning: "Check",
  disabled: "Off",
  draft: "Draft",
  info: "Info",
};

const TONE_CLASSES: Record<ResourceDiscoveryTone, string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
  disabled: "border-border bg-muted text-muted-foreground",
  draft: "border-border bg-background text-muted-foreground",
  info: "border-sky-200 bg-sky-50 text-sky-700",
};

function ResourceDiscoveryRowView({
  icon: Icon,
  label,
  row,
}: {
  icon: LucideIcon;
  label: string;
  row: ResourceDiscoveryRow;
}) {
  return (
    <div className="flex gap-2 py-2">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">{label}</p>
            <p className="text-xs leading-5 text-muted-foreground">
              {row.title}
            </p>
          </div>
          <Badge
            variant="outline"
            className={`h-5 shrink-0 px-1.5 text-[10px] ${TONE_CLASSES[row.tone]}`}
          >
            {TONE_LABELS[row.tone]}
          </Badge>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          {row.summary}
        </p>
        {row.value ? (
          <code className="block truncate text-[11px] text-muted-foreground">
            {row.value}
          </code>
        ) : null}
      </div>
    </div>
  );
}

export function ResourceDiscoveryReadiness(
  props: Omit<ResourceDiscoveryPreviewInput, "discovery" | "storefrontUrl" | "policySource">,
) {
  const { storefrontUrl } = useStorefrontUrl();
  const seoSettingsQuery = useQuery(seoSettingsQueryOptions());
  const discovery =
    seoSettingsQuery.data?.discovery ?? DEFAULT_SEO_DISCOVERY_SETTINGS;
  const policySource = seoSettingsQuery.data?.discovery ? "current" : "default";
  const preview = buildResourceDiscoveryPreview({
    ...props,
    discovery,
    storefrontUrl,
    policySource,
  });

  return (
    <div className="border-t border-border pt-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <SearchCheck className="h-3.5 w-3.5 text-muted-foreground" />
            <h4 className="text-sm font-medium">Discovery Readiness</h4>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Expected after save from {preview.copy.subject} data and global
            discovery policy.
          </p>
        </div>
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {preview.policy.label}
        </Badge>
      </div>

      <div className="divide-y divide-border">
        <ResourceDiscoveryRowView
          icon={Link2}
          label="Canonical"
          row={preview.canonical}
        />
        <ResourceDiscoveryRowView
          icon={Globe2}
          label="Sitemap XML"
          row={preview.sitemap}
        />
        <ResourceDiscoveryRowView
          icon={Braces}
          label={preview.copy.schemaLabel}
          row={preview.structuredData}
        />
      </div>

      {preview.policy.source === "default" ? (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {preview.policy.summary}
        </p>
      ) : null}
    </div>
  );
}
