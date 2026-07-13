import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  MinusCircle,
  Monitor,
  Server,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { cn } from "@scalius/shared/utils";
import type {
  AnalyticsProviderBrowserStatus,
  AnalyticsProviderHealthResponse,
  AnalyticsProviderServerStatus,
} from "~/types/api-responses";
import {
  OfficialProviderMark,
  type ProviderMarkId,
} from "~/components/admin/settings/provider-marks";

interface AnalyticsProviderHealthProps {
  health: AnalyticsProviderHealthResponse;
}

const PROVIDER_MARK_BY_TYPE: Partial<Record<string, ProviderMarkId>> = {
  cloudflare_web_analytics: "cloudflare",
  google_analytics: "google-analytics",
  google_tag_manager: "google-tag-manager",
  facebook_pixel: "meta",
  tiktok_pixel: "tiktok",
};

type StatusBadgeConfig<TStatus extends string> = Record<
  TStatus,
  { label: string; icon: LucideIcon; className: string }
>;

const browserStatusConfig: StatusBadgeConfig<AnalyticsProviderBrowserStatus> = {
  ready: { label: "Browser ready", icon: CheckCircle2, className: "text-emerald-700 dark:text-emerald-300" },
  draft: { label: "Draft", icon: CircleDashed, className: "text-sky-700 dark:text-sky-300" },
  blocked: { label: "Blocked", icon: AlertTriangle, className: "text-destructive" },
  not_configured: { label: "Not configured", icon: MinusCircle, className: "text-muted-foreground" },
};
const serverStatusConfig: StatusBadgeConfig<AnalyticsProviderServerStatus> = {
  ready: { label: "Server ready", icon: Server, className: "text-emerald-700 dark:text-emerald-300" },
  blocked: { label: "Server blocked", icon: AlertTriangle, className: "text-destructive" },
  not_configured: { label: "Server not configured", icon: Server, className: "text-amber-800 dark:text-amber-300" },
  not_applicable: { label: "Browser only", icon: Monitor, className: "text-muted-foreground" },
};

function StatusBadge<TStatus extends string>({
  config,
  status,
  label,
}: {
  config: StatusBadgeConfig<TStatus>;
  status: TStatus;
  label?: string;
}) {
  const value = config[status];
  const Icon = value.icon;
  return (
    <Badge variant="outline" className={cn("gap-1 bg-background", value.className)}>
      <Icon className="h-3 w-3" />
      {label ?? value.label}
    </Badge>
  );
}

export function AnalyticsProviderHealth({ health }: AnalyticsProviderHealthProps) {
  const { summary, providers } = health;
  const configuredProviders = providers.filter((provider) => provider.browser.configured);

  return (
    <details className="group overflow-hidden rounded-lg border bg-background">
      <summary className="flex cursor-pointer list-none flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 items-center gap-3">
          <div className={cn(
            "h-8 w-1 shrink-0 rounded-full",
            summary.blockedProviders > 0 ? "bg-destructive" : "bg-emerald-500",
          )} />
          <div className="min-w-0">
            <p className="text-sm font-semibold">Provider readiness</p>
            <p className="line-clamp-2 text-xs text-muted-foreground sm:line-clamp-1">
              {summary.blockedProviders > 0
                ? `${summary.blockedProviders} provider${summary.blockedProviders === 1 ? "" : "s"} need attention before reliable tracking.`
                : `${summary.browserReadyProviders} browser and ${summary.serverReadyProviders} server integrations are ready.`}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="gap-1 text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-3 w-3" />
            {summary.browserReadyProviders} ready
          </Badge>
          <Badge
            variant="outline"
            className={summary.blockedProviders > 0 ? "text-destructive" : "text-muted-foreground"}
          >
            {summary.blockedProviders} blocked
          </Badge>
          <span className="text-xs text-muted-foreground">
            {configuredProviders.length} configured
          </span>
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
        </div>
      </summary>

      <ul className="grid border-t bg-muted/15 lg:grid-cols-2">
        {providers.map((provider) => (
          <li
            key={provider.provider}
            className="flex min-w-0 items-start justify-between gap-3 border-b px-3 py-2.5 last:border-b-0 lg:odd:border-r lg:[&:nth-last-child(-n+2)]:border-b-0"
          >
            <div className="flex min-w-0 items-start gap-2.5">
              {PROVIDER_MARK_BY_TYPE[provider.provider] ? (
                <OfficialProviderMark provider={PROVIDER_MARK_BY_TYPE[provider.provider]!} />
              ) : null}
              <div className="min-w-0">
                <p className="text-sm font-medium">{provider.label}</p>
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                  {provider.browser.issues[0] ?? provider.browser.message}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <StatusBadge config={browserStatusConfig} status={provider.browser.status} />
              {provider.provider === "facebook_pixel" ? (
                <StatusBadge
                  config={serverStatusConfig}
                  status={provider.serverSide.status}
                  label={provider.serverSide.label}
                />
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
