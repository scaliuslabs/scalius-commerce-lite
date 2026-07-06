import {
  AlertTriangle,
  CheckCircle2,
  CircleOff,
  ExternalLink,
  FileSearch,
  Info,
  Link2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { SeoDiscoverySettings } from "@scalius/shared/seo-discovery";

import { Badge } from "../ui/badge";
import { useStorefrontUrl } from "../../hooks/use-storefront-url";
import {
  buildSeoDiscoveryStatus,
  type SeoDiscoveryStatus,
  type SeoDiscoveryTone,
} from "../../lib/seo-discovery-status";

interface SeoDiscoveryStatusCardProps {
  discovery: SeoDiscoverySettings;
  robotsTxt: string;
}

const TONE_LABELS: Record<SeoDiscoveryTone, string> = {
  ok: "OK",
  warning: "Check",
  disabled: "Off",
  info: "Info",
};

const TONE_CLASSES: Record<SeoDiscoveryTone, string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
  disabled: "border-border bg-muted text-muted-foreground",
  info: "border-sky-200 bg-sky-50 text-sky-700",
};

const TONE_ICONS: Record<SeoDiscoveryTone, LucideIcon> = {
  ok: CheckCircle2,
  warning: AlertTriangle,
  disabled: CircleOff,
  info: Info,
};

function toneClassName(tone: SeoDiscoveryTone): string {
  return TONE_CLASSES[tone];
}

interface StatusRowProps {
  tone: SeoDiscoveryTone;
  title: string;
  summary: string;
  children?: ReactNode;
}

function StatusRow({ tone, title, summary, children }: StatusRowProps) {
  const Icon = TONE_ICONS[tone];

  return (
    <div className="border-t border-border px-4 py-3 first:border-t-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <h4 className="text-sm font-medium">{title}</h4>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">{summary}</p>
        </div>
        <Badge
          variant="outline"
          className={`w-fit shrink-0 ${toneClassName(tone)}`}
        >
          {TONE_LABELS[tone]}
        </Badge>
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}

function SectionChips({
  sections,
}: {
  sections: SeoDiscoveryStatus["sitemap"]["includedSections"];
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {sections.map((section) => (
        <Badge
          key={section.key}
          variant="outline"
          className={
            section.enabled
              ? "border-border bg-background text-foreground"
              : "border-border bg-muted text-muted-foreground"
          }
        >
          {section.label}
        </Badge>
      ))}
    </div>
  );
}

function PreviewLinks({ status }: { status: SeoDiscoveryStatus["storefront"] }) {
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-3">
        {status.links.map((link) =>
          link.href ? (
            <a
              key={link.key}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              <span className="truncate">{link.label}</span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </a>
          ) : (
            <div
              key={link.key}
              className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground"
            >
              <span className="truncate">{link.label}</span>
              <code className="shrink-0 text-[11px]">{link.path}</code>
            </div>
          ),
        )}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{status.note}</p>
    </div>
  );
}

export function SeoDiscoveryStatusCard({
  discovery,
  robotsTxt,
}: SeoDiscoveryStatusCardProps) {
  const {
    storefrontUrl,
    isLoading: isStorefrontUrlLoading,
    error: storefrontUrlError,
  } = useStorefrontUrl();
  const status = buildSeoDiscoveryStatus({
    discovery,
    robotsTxt,
    storefrontUrl,
  });
  const storefrontSummary = isStorefrontUrlLoading
    ? "Loading the dashboard Store URL preview."
    : status.storefront.summary;
  const storefrontNote = storefrontUrlError
    ? "Store URL preview failed to load; editing remains available."
    : status.storefront.note;

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-start gap-3 px-4 py-3">
        <FileSearch className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Discovery Status / QA</h3>
          <p className="text-xs leading-5 text-muted-foreground">
            Read-only checklist from the current discovery policy and dashboard
            Store URL setting.
          </p>
        </div>
      </div>

      <StatusRow
        tone={status.sitemap.tone}
        title={status.sitemap.title}
        summary={status.sitemap.summary}
      >
        <SectionChips sections={status.sitemap.includedSections} />
      </StatusRow>

      <StatusRow
        tone={status.productFeed.tone}
        title={status.productFeed.title}
        summary={status.productFeed.summary}
      >
        <div className="space-y-1 text-xs leading-5 text-muted-foreground">
          <p>
            Output mode:{" "}
            <span className="font-medium text-foreground">
              {status.productFeed.variantStrategyLabel}
            </span>
          </p>
          <p>{status.productFeed.imagePolicy}</p>
          <p>
            XML title:{" "}
            <span className="font-medium text-foreground">
              {status.productFeed.feedTitle}
            </span>
          </p>
          <p>
            XML description:{" "}
            <span className="font-medium text-foreground">
              {status.productFeed.feedDescription}
            </span>
          </p>
        </div>
      </StatusRow>

      <StatusRow
        tone={status.robots.tone}
        title={status.robots.title}
        summary={status.robots.summary}
      >
        {status.robots.warning ? (
          <p className="text-xs leading-5 text-amber-700">
            {status.robots.warning}
          </p>
        ) : (
          <p className="text-xs leading-5 text-muted-foreground">
            No custom Sitemap lines detected.
          </p>
        )}
      </StatusRow>

      <StatusRow
        tone={status.structuredData.tone}
        title={status.structuredData.title}
        summary={status.structuredData.summary}
      >
        <p className="text-xs leading-5 text-muted-foreground">
          {status.structuredData.organizationNote}
        </p>
      </StatusRow>

      <StatusRow
        tone={status.storefront.tone}
        title={status.storefront.title}
        summary={storefrontSummary}
      >
        <PreviewLinks status={{ ...status.storefront, note: storefrontNote }} />
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <Link2 className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            {status.storefront.baseUrl ?? "No absolute dashboard Store URL"}
          </span>
        </div>
      </StatusRow>
    </div>
  );
}
