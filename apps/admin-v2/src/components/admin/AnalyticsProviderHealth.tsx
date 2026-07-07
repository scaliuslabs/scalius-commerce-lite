import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  MinusCircle,
  Monitor,
  Server,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { cn } from "@scalius/shared/utils";
import type {
  AnalyticsProviderBrowserStatus,
  AnalyticsProviderHealthResponse,
  AnalyticsProviderServerStatus,
} from "~/types/api-responses";

interface AnalyticsProviderHealthProps {
  health: AnalyticsProviderHealthResponse;
}

type StatusBadgeConfig<TStatus extends string> = Record<
  TStatus,
  {
    label: string;
    icon: LucideIcon;
    className: string;
  }
>;

const browserStatusConfig: StatusBadgeConfig<AnalyticsProviderBrowserStatus> = {
  ready: {
    label: "Browser ready",
    icon: CheckCircle2,
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  draft: {
    label: "Draft",
    icon: CircleDashed,
    className: "border-sky-200 bg-sky-50 text-sky-700",
  },
  blocked: {
    label: "Blocked",
    icon: AlertTriangle,
    className: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  not_configured: {
    label: "Not configured",
    icon: MinusCircle,
    className: "border-muted bg-muted text-muted-foreground",
  },
};

const serverStatusConfig: StatusBadgeConfig<AnalyticsProviderServerStatus> = {
  ready: {
    label: "Server ready",
    icon: Server,
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  blocked: {
    label: "Server blocked",
    icon: AlertTriangle,
    className: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  not_configured: {
    label: "Server not configured",
    icon: Server,
    className: "border-amber-200 bg-amber-50 text-amber-800",
  },
  not_applicable: {
    label: "Browser only",
    icon: Monitor,
    className: "border-muted bg-muted text-muted-foreground",
  },
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
  const statusConfig = config[status];
  const Icon = statusConfig.icon;

  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 whitespace-nowrap", statusConfig.className)}
    >
      <Icon className="h-3.5 w-3.5" />
      {label ?? statusConfig.label}
    </Badge>
  );
}

export function AnalyticsProviderHealth({
  health,
}: AnalyticsProviderHealthProps) {
  const { summary, providers } = health;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 pb-3 lg:flex-row lg:items-center lg:justify-between">
        <CardTitle>Provider Readiness</CardTitle>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className="gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
            {summary.browserReadyProviders} browser ready
          </Badge>
          <Badge
            variant="outline"
            className={cn(
              "gap-1.5",
              summary.blockedProviders > 0
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : "text-muted-foreground",
            )}
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            {summary.blockedProviders} blocked
          </Badge>
          <Badge variant="outline" className="gap-1.5 text-muted-foreground">
            <Server className="h-3.5 w-3.5" />
            {summary.serverReadyProviders} server ready
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="divide-y rounded-md border">
          {providers.map((provider) => (
            <li
              key={provider.provider}
              className="grid gap-3 px-3 py-3 lg:grid-cols-[minmax(0,1fr)_auto]"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold">{provider.label}</h2>
                  <span className="text-xs text-muted-foreground">
                    {provider.browser.activeScriptCount} active,{" "}
                    {provider.browser.draftScriptCount} draft
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {provider.browser.message}
                </p>
                {provider.browser.issues.length > 0 ? (
                  <p className="text-xs font-medium text-destructive">
                    {provider.browser.issues.join(" ")}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {provider.serverSide.message}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-start gap-2 lg:justify-end">
                <StatusBadge
                  config={browserStatusConfig}
                  status={provider.browser.status}
                />
                <StatusBadge
                  config={serverStatusConfig}
                  status={provider.serverSide.status}
                  label={provider.serverSide.label}
                />
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
