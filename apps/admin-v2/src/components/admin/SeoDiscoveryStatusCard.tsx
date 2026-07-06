import {
  AlertTriangle,
  CheckCircle2,
  CircleOff,
  ExternalLink,
  FileSearch,
  Info,
  Link2,
  RefreshCw,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  ProductFeedDiagnosticReason,
  ProductFeedDiagnosticsReport,
} from "@scalius/core/modules/products";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { useStorefrontUrl } from "../../hooks/use-storefront-url";
import { seoFeedDiagnosticsQueryOptions } from "../../lib/api-query-options/seo-feed-diagnostics";
import { seoDiscoveryLiveProbeQueryOptions } from "../../lib/api-query-options/seo-discovery-live-probe";
import {
  buildSeoDiscoveryStatus,
  type SeoDiscoverySettingsWithReturnPolicy,
  type SeoDiscoveryLiveProbeResource,
  type SeoDiscoveryLiveProbeResult,
  type SeoDiscoveryStatus,
  type SeoDiscoveryTone,
} from "../../lib/seo-discovery-status";

interface SeoDiscoveryStatusCardProps {
  discovery: SeoDiscoverySettingsWithReturnPolicy;
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

const FEED_REASON_LABELS: Record<ProductFeedDiagnosticReason, string> = {
  feed_disabled: "Feed disabled",
  storefront_url_unavailable: "Storefront URL unavailable",
  product_feed_excluded: "Excluded by product",
  inactive_deleted_unpublished: "Inactive or deleted",
  no_buyer_sku: "No buyer-safe SKU",
  missing_image: "Missing primary image",
  unavailable_excluded: "Sold out hidden",
};

function toneClassName(tone: SeoDiscoveryTone): string {
  return TONE_CLASSES[tone];
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function plural(value: number, singular: string, pluralLabel = `${singular}s`) {
  return value === 1 ? singular : pluralLabel;
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

function getLiveProbeSummaryTone(
  result: SeoDiscoveryLiveProbeResult | undefined,
  enabled: boolean,
  isBusy: boolean,
  error: unknown,
): SeoDiscoveryTone {
  if (!enabled) return "disabled";
  if (error) return "warning";
  if (isBusy && !result) return "info";
  if (!result) return "info";
  if (!result.ok || result.error) return "warning";

  const robots = result.resources.find((resource) => resource.key === "robots");
  const sitemap = result.resources.find(
    (resource) => resource.key === "sitemap",
  );
  if ((robots?.counts.robotsSitemapLines ?? 0) < 1) return "warning";
  if ((sitemap?.counts.sitemapLocs ?? 0) < 1) return "warning";

  return "ok";
}

function getLiveProbeResourceTone(
  resource: SeoDiscoveryLiveProbeResource,
): SeoDiscoveryTone {
  if (!resource.ok || resource.error) return "warning";
  if (
    resource.key === "robots" &&
    (resource.counts.robotsSitemapLines ?? 0) < 1
  ) {
    return "warning";
  }
  if (
    resource.key === "sitemap" &&
    (resource.counts.sitemapLocs ?? 0) < 1
  ) {
    return "warning";
  }
  return "ok";
}

function formatProbeCounts(resource: SeoDiscoveryLiveProbeResource): string {
  if (resource.key === "robots") {
    const count = resource.counts.robotsSitemapLines ?? 0;
    return `${count} Sitemap line${count === 1 ? "" : "s"}`;
  }

  if (resource.key === "sitemap") {
    return `${resource.counts.sitemapLocs ?? 0} loc`;
  }

  return `${resource.counts.feedItems ?? 0} item; ${
    resource.counts.imageLinks ?? 0
  } image_link; ${resource.counts.availabilityValues ?? 0} availability`;
}

function formatHeaderValue(value: string | null): string {
  return value ?? "none";
}

function LiveProbeRows({
  resources,
}: {
  resources: SeoDiscoveryLiveProbeResource[];
}) {
  return (
    <div className="divide-y divide-border border-t border-border">
      {resources.map((resource) => {
        const tone = getLiveProbeResourceTone(resource);
        const statusLabel = resource.status ? String(resource.status) : "No response";

        return (
          <div
            key={resource.key}
            className="grid gap-2 py-2 sm:grid-cols-[minmax(0,1fr)_auto]"
          >
            <div className="min-w-0 space-y-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-xs font-medium text-foreground">
                  {resource.label}
                </span>
                <code className="shrink-0 text-[11px] text-muted-foreground">
                  {statusLabel}
                </code>
              </div>
              <div className="grid min-w-0 gap-1 text-[11px] leading-4 text-muted-foreground sm:grid-cols-3">
                <span className="truncate">
                  Type: {formatHeaderValue(resource.contentType)}
                </span>
                <span className="truncate">
                  Cache: {formatHeaderValue(resource.cacheControl)}
                </span>
                <span className="truncate">{formatProbeCounts(resource)}</span>
              </div>
              {resource.error || resource.bodyTruncated ? (
                <p className="text-[11px] leading-4 text-amber-700">
                  {resource.error ??
                    "Response body read reached the diagnostic cap."}
                </p>
              ) : null}
            </div>
            <Badge
              variant="outline"
              className={`w-fit shrink-0 self-start ${toneClassName(tone)}`}
            >
              {TONE_LABELS[tone]}
            </Badge>
          </div>
        );
      })}
    </div>
  );
}

function LiveProbePanel({
  enabled,
  error,
  isFetching,
  isLoading,
  onRetry,
  result,
}: {
  enabled: boolean;
  error: unknown;
  isFetching: boolean;
  isLoading: boolean;
  onRetry: () => void;
  result: SeoDiscoveryLiveProbeResult | undefined;
}) {
  const isBusy = isLoading || isFetching;
  const tone = getLiveProbeSummaryTone(result, enabled, isBusy, error);
  const errorMessage = error instanceof Error ? error.message : null;
  const title =
    isBusy && !result
      ? "Checking live discovery files"
      : tone === "ok"
        ? "Live proof complete"
        : "Live proof needs review";

  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <h4 className="text-xs font-semibold uppercase text-muted-foreground">
              Live proof
            </h4>
            <Badge
              variant="outline"
              className={`w-fit shrink-0 ${toneClassName(tone)}`}
            >
              {TONE_LABELS[tone]}
            </Badge>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            {enabled
              ? title
              : "Live proof waits for an absolute http(s) Store URL."}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={!enabled || isBusy}
          className="w-fit"
        >
          <RefreshCw className={isBusy ? "animate-spin" : ""} />
          Retry
        </Button>
      </div>

      {errorMessage ? (
        <p className="text-xs leading-5 text-amber-700">{errorMessage}</p>
      ) : result?.error ? (
        <p className="text-xs leading-5 text-amber-700">{result.error}</p>
      ) : null}

      {result?.resources.length ? (
        <LiveProbeRows resources={result.resources} />
      ) : null}
    </div>
  );
}

function getFeedDiagnosticsTone({
  enabled,
  error,
  isBusy,
  result,
}: {
  enabled: boolean;
  error: unknown;
  isBusy: boolean;
  result: ProductFeedDiagnosticsReport | undefined;
}): SeoDiscoveryTone {
  if (!enabled) return "disabled";
  if (error) return "warning";
  if (isBusy && !result) return "info";
  if (!result) return "info";
  return result.totals.productsWithIssues > 0 ? "warning" : "ok";
}

function FeedDiagnosticsPanel({
  enabled,
  error,
  isFetching,
  isLoading,
  onRetry,
  result,
}: {
  enabled: boolean;
  error: unknown;
  isFetching: boolean;
  isLoading: boolean;
  onRetry: () => void;
  result: ProductFeedDiagnosticsReport | undefined;
}) {
  const isBusy = isLoading || isFetching;
  const tone = getFeedDiagnosticsTone({ enabled, error, isBusy, result });
  const errorMessage = error instanceof Error ? error.message : null;
  const activeReasons =
    result?.reasons.filter(
      (reason) => reason.products > 0 || reason.rows > 0,
    ) ?? [];
  const title =
    isBusy && !result
      ? "Scanning catalog"
      : tone === "ok"
        ? "Catalog ready"
        : tone === "disabled"
          ? "Catalog feed disabled"
          : "Catalog needs attention";

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <h4 className="text-xs font-semibold uppercase text-muted-foreground">
              Catalog diagnostics
            </h4>
            <Badge
              variant="outline"
              className={`w-fit shrink-0 ${toneClassName(tone)}`}
            >
              {TONE_LABELS[tone]}
            </Badge>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">{title}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={isBusy}
          className="w-fit"
        >
          <RefreshCw className={isBusy ? "animate-spin" : ""} />
          Refresh
        </Button>
      </div>

      {errorMessage ? (
        <p className="text-xs leading-5 text-amber-700">{errorMessage}</p>
      ) : null}

      {result ? (
        <div className="space-y-3 text-xs leading-5">
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className="border-border bg-background">
              Rows ready: {formatCount(result.totals.emittedRows)}
            </Badge>
            <Badge variant="outline" className="border-border bg-background">
              Skipped rows: {formatCount(result.totals.skippedRows)}
            </Badge>
            <Badge variant="outline" className="border-border bg-background">
              Products to fix: {formatCount(result.totals.productsWithIssues)}
            </Badge>
          </div>

          <p className="text-muted-foreground">
            Scanned {formatCount(result.scan.scannedProducts)} of first{" "}
            {formatCount(result.scan.limit)}{" "}
            {plural(result.scan.limit, "product")}.
            {result.scan.truncated
              ? " More products exist outside this bounded scan."
              : ""}
          </p>

          {activeReasons.length > 0 ? (
            <div className="divide-y divide-border border-t border-border">
              {activeReasons.map((reason) => (
                <div
                  key={reason.reason}
                  className="grid gap-2 py-2 sm:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium text-foreground">
                      {FEED_REASON_LABELS[reason.reason]}
                    </p>
                    <p className="text-muted-foreground">
                      {formatCount(reason.products)}{" "}
                      {plural(reason.products, "product")} ·{" "}
                      {formatCount(reason.rows)} skipped{" "}
                      {plural(reason.rows, "row")}
                    </p>
                    {reason.samples.length > 0 ? (
                      <p className="truncate text-[11px] text-muted-foreground">
                        Sample:{" "}
                        {reason.samples
                          .map((sample) => sample.name || sample.slug)
                          .join(", ")}
                      </p>
                    ) : null}
                  </div>
                  <Badge
                    variant="outline"
                    className={`w-fit shrink-0 self-start ${toneClassName(
                      reason.reason === "feed_disabled" ? "disabled" : "warning",
                    )}`}
                  >
                    {formatCount(reason.products)}
                  </Badge>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground">
              No feed blockers found in this bounded scan.
            </p>
          )}
        </div>
      ) : null}
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
  const liveProbeEnabled =
    status.storefront.mode === "absolute" &&
    !isStorefrontUrlLoading &&
    !storefrontUrlError;
  const liveProbeQuery = useQuery({
    ...seoDiscoveryLiveProbeQueryOptions(),
    enabled: liveProbeEnabled,
  });
  const feedDiagnosticsQuery = useQuery(seoFeedDiagnosticsQueryOptions());
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
          <FeedDiagnosticsPanel
            enabled={discovery.feeds.productCatalogEnabled}
            error={feedDiagnosticsQuery.error}
            isFetching={feedDiagnosticsQuery.isFetching}
            isLoading={feedDiagnosticsQuery.isLoading}
            onRetry={() => {
              void feedDiagnosticsQuery.refetch();
            }}
            result={feedDiagnosticsQuery.data}
          />
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
        <div className="space-y-1 text-xs leading-5 text-muted-foreground">
          <p>{status.structuredData.organizationNote}</p>
          <p>
            Return policy:{" "}
            <span className="font-medium text-foreground">
              {status.structuredData.returnPolicySummary}
            </span>
          </p>
        </div>
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
        <LiveProbePanel
          enabled={liveProbeEnabled}
          error={liveProbeQuery.error}
          isFetching={liveProbeQuery.isFetching}
          isLoading={liveProbeQuery.isLoading}
          onRetry={() => {
            void liveProbeQuery.refetch();
          }}
          result={liveProbeQuery.data}
        />
      </StatusRow>
    </div>
  );
}
