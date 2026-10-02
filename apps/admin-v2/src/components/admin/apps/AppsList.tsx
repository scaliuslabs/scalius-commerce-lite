// Apps: every app installed in this store (Shopify's "Apps"), one row each
// with its status and the checkout points it implements; a row opens the
// app's page.
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Blocks, ChevronRight } from "lucide-react";
import { EmptyState } from "~/components/admin/resource/EmptyState";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { useMessages } from "~/i18n";
import { installedAppsMessages } from "~/i18n/apps";
import { appsQueryOptions, type AppSummary } from "~/lib/api-query-options/apps";
import { checkoutFunctions, isKnownFunctionPoint } from "./app-functions";
import { AppStatusBadge } from "./app-status";

function AppRow({ app }: { app: AppSummary }) {
  const t = useMessages(installedAppsMessages);
  const functions = checkoutFunctions(app.functions);
  return (
    <li className="border-t border-border first:border-t-0">
      <Link
        to="/admin/apps/$pluginId"
        params={{ pluginId: app.id }}
        className="flex items-start gap-3 px-4 py-3 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
          <Blocks className="size-5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-body font-medium">{app.name}</span>
            <AppStatusBadge app={app} />
          </span>
          {app.description ? <span className="line-clamp-2 block text-body">{app.description}</span> : null}
          <span className="block text-body text-muted-foreground">{t("byline", { version: app.version, author: app.author.name })}</span>
          {functions.length > 0 ? (
            <span className="flex flex-wrap items-center gap-1">
              <span className="text-body text-muted-foreground">{t("listCheckout")}</span>
              {functions.map((fn) => (
                <Badge key={fn.point} variant="outline">
                  {isKnownFunctionPoint(fn.point) ? t(`chip_${fn.point}`) : <span className="font-mono">{fn.point}</span>}
                </Badge>
              ))}
            </span>
          ) : null}
        </span>
        <span className="flex h-10 items-center">
          <ChevronRight className="size-4 text-muted-foreground rtl:rotate-180" aria-hidden="true" />
        </span>
      </Link>
    </li>
  );
}

export function AppsList() {
  const t = useMessages(installedAppsMessages);
  const { data, isError, isRefetching, refetch } = useQuery(appsQueryOptions());

  let body: ReactNode;
  if (isError) {
    body = (
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-4">
        <p className="text-body text-destructive">{t("listFailed")}</p>
        <Button type="button" variant="outline" size="sm" loading={isRefetching} onClick={() => void refetch()}>{t("tryAgain")}</Button>
      </div>
    );
  } else if (!data) {
    body = (
      <div aria-busy className="space-y-4 px-4 py-4">
        {[0, 1].map((row) => (
          <div key={row} className="flex items-start gap-3">
            <Skeleton className="size-10" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    );
  } else if (data.apps.length === 0) {
    body = <EmptyState icon={Blocks} title={t("emptyTitle")} description={t("emptyBody")} />;
  } else {
    body = <ul>{data.apps.map((app) => <AppRow key={app.id} app={app} />)}</ul>;
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t("title")} />
      <Card className="overflow-clip">{body}</Card>
    </div>
  );
}
