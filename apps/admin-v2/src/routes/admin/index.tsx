import { lazy, Suspense, type ReactNode } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, ChevronRight, CreditCard, ImageOff, Inbox, Menu, Package, TriangleAlert } from "lucide-react";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { unixToDate } from "@scalius/shared/timestamps";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { InlineError } from "~/components/admin/states/InlineError";
import { statusBadgeVariant } from "~/components/admin/orderview/status-badges";
import { orderMessages, orderStatusLabel } from "~/i18n/orders";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { AppHomeWidgets } from "~/components/admin/apps/ui/AppResourceCards";
import { usePermissions } from "~/contexts/PermissionContext";
import { useCurrency } from "~/hooks/use-currency";
import { canAccessAdminPath } from "~/lib/admin-access";
import { homeSmsQueryOptions } from "~/lib/api-query-options/dashboard-home";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { RouteErrorComponent } from "~/lib/route-error";
import { adminCalendarDateKey } from "~/lib/admin-time";
import {
  HOME_FEED_STALE_TIME_MS,
  dashboardActivityQueryOptions,
  dashboardSummaryQueryOptions,
  homeLowStockQueryOptions,
  homeOpenOrdersQueryOptions,
  homeOverdueInvoicesQueryOptions,
  setupGuideQueryOptions,
} from "~/lib/api-query-options/dashboard-home";
import { currencySettingsQueryOptions } from "~/lib/api-query-options/currency";
import { countFeedGaps, feedDiagnosticsQueryOptions, navigationPlacementsQueryOptions } from "~/lib/api-query-options/online-store";
import { formatDateTime, formatNumber, useMessages } from "~/i18n";
import { homeMessages } from "~/i18n/home";
import { pageHead } from "~/i18n/page-titles";

/** The API counts products only online payment can pay for up to here ("1,000+"). */
const ONLINE_PAID_PRODUCT_COUNT_CAP = 1000;

export const Route = createFileRoute("/admin/")({
  // Every Home read starts here, in one round trip, rather than after the
  // page's code has loaded and rendered.
  loader: ({ context: { queryClient, permissions, isSuperAdmin } }) => {
    const canOpen = (to: string) => canAccessAdminPath(to, { permissions, isSuperAdmin });
    void queryClient.prefetchQuery(dashboardSummaryQueryOptions());
    void queryClient.prefetchQuery(dashboardActivityQueryOptions());
    void queryClient.prefetchQuery(currencySettingsQueryOptions());
    void queryClient.prefetchQuery(setupGuideQueryOptions());
    // The sales strip's code downloads with the navigation, then starts its
    // read (a failed download shows in the strip itself).
    if (canOpen("/admin/analytics")) {
      import("~/components/admin/analytics/HomeAnalytics")
        .then(({ homeOverviewQuery }) => queryClient.prefetchQuery(homeOverviewQuery("last_30_days")))
        .catch(() => undefined);
    }
    if (canOpen("/admin/orders")) void queryClient.prefetchQuery(homeOpenOrdersQueryOptions());
    if (canOpen("/admin/inventory")) void queryClient.prefetchQuery(homeLowStockQueryOptions());
    if (canOpen("/admin/online-store/preferences")) void queryClient.prefetchQuery({ ...feedDiagnosticsQueryOptions(), staleTime: HOME_FEED_STALE_TIME_MS });
    if (canOpen("/admin/online-store/navigation")) void queryClient.prefetchQuery(navigationPlacementsQueryOptions());
  },
  head: () => pageHead("home"),
  errorComponent: RouteErrorComponent,
  component: HomePage,
});

// The sales strip (its chart, tiles and copy) loads just after Home's own code;
// its read already started in the loader.
const HomeAnalytics = lazy(() => import("~/components/admin/analytics/HomeAnalytics").then((module) => ({ default: module.HomeAnalytics })));

// The setup guide's code loads after Home's first render; its read starts in
// the loader, and Home mounts it only while this staff member keeps it.
const SetupGuide = lazy(() => import("~/components/admin/onboarding/SetupGuide"));

/** The strip's own loading shape: the range buttons, then four tiles. */
function HomeAnalyticsSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true">
      <Skeleton className="h-8 w-72 max-w-full" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {["a", "b", "c", "d"].map((key) => <Skeleton key={key} className="h-28" />)}
      </div>
    </div>
  );
}



function HomePage() {
  const t = useMessages(homeMessages);
  const to = useMessages(orderMessages);
  const { fmt } = useCurrency();
  const { permissions, isSuperAdmin } = usePermissions();
  const canOpen = (to: string) => canAccessAdminPath(to, { permissions, isSuperAdmin });
  const summary = useQuery(dashboardSummaryQueryOptions());
  const activity = useQuery(dashboardActivityQueryOptions());
  const openOrders = useQuery({ ...homeOpenOrdersQueryOptions(), enabled: canOpen("/admin/orders") });
  const overdueInvoices = useQuery({ ...homeOverdueInvoicesQueryOptions(), enabled: canOpen("/admin/orders") });
  const lowStock = useQuery({ ...homeLowStockQueryOptions(), enabled: canOpen("/admin/inventory") });
  // Store readiness (Shopify's Home tasks): products the product feed leaves
  // out for a fixable reason, and a storefront header without a menu.
  const feed = useQuery({
    ...feedDiagnosticsQueryOptions(),
    enabled: canOpen("/admin/online-store/preferences"),
    staleTime: HOME_FEED_STALE_TIME_MS,
  });
  const placements = useQuery({ ...navigationPlacementsQueryOptions(), enabled: canOpen("/admin/online-store/navigation") });
  // A chosen SMS gateway that cannot send (its app is not active, as after the
  // Bangladesh gateways moved into the Bangladesh pack): order texts and sign-in codes stop.
  const sms = useQuery({ ...homeSmsQueryOptions(), enabled: isSuperAdmin || permissions.has(ADMIN_PERMISSIONS.SETTINGS_GENERAL_VIEW) });
  const setupGuide = useQuery(setupGuideQueryOptions());

  // One failed read never blanks Home (polish bar R3): its own cards say so
  // with Retry, the setup guide, sales strip and to-dos still render.
  const summaryError = summary.isError ? (
    <InlineError title={t("loadFailed")} error={summary.error} onRetry={() => void summary.refetch()} />
  ) : null;
  const recentOrders = summary.data?.recentOrders;
  const month = summary.data?.stats.currentMonth;

  // Sales numbers come from Analytics (the same definitions); a role without
  // "View analytics" sees order counts only, and the API sends it no money.
  const sales = canOpen("/admin/analytics");
  const canSeeOrders = canOpen("/admin/orders");
  const today = (activity.data?.dailyActivityData ?? []).find((day) => day.date === adminCalendarDateKey());
  const openCount = openOrders.data?.pagination.total ?? 0;
  const overdueCount = overdueInvoices.data?.pagination.total ?? 0;
  const lowCount = lowStock.data?.alerts.length ?? 0;
  const feedGaps = countFeedGaps(feed.data);
  const needsHeaderMenu = placements.data !== undefined && !placements.data.some(({ placement, menuDeletedAt, publicationItemCount }) =>
    placement.surface === "header" && placement.isEnabled && !menuDeletedAt && (publicationItemCount ?? 0) > 0);
  const smsBlocked = Boolean(sms.data?.activeProvider) && sms.data?.activeProviderConfigured === false;
  // Active digital products and gift cards a cash-on-delivery-only checkout can't take.
  const onlinePaymentBlocked = setupGuide.data?.onlinePayment?.blockedProducts ?? 0;
  const caughtUp = openCount === 0 && overdueCount === 0 && lowCount === 0 && feedGaps === 0 && !needsHeaderMenu && !smsBlocked && onlinePaymentBlocked === 0;

  return (
    <div className="space-y-4 pb-8">
      <PageHeader title={t("home")} />
      {setupGuide.data && !setupGuide.data.dismissed ? (
        <Suspense fallback={null}>
          <SetupGuide guide={setupGuide.data} canOpen={canOpen} />
        </Suspense>
      ) : null}
      {sales ? (
        <Suspense fallback={<HomeAnalyticsSkeleton />}>
          <HomeAnalytics />
        </Suspense>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Metric label={t("ordersToday")} value={formatNumber(today?.orders ?? 0)} />
            {month ? <Metric label={t("ordersThisMonth")} value={formatNumber(month.orders)} change={month.orderGrowth} /> : null}
          </div>
          {summaryError}
          <p className="text-body text-muted-foreground">{t("noSalesAccess")}</p>
        </>
      )}

      {/* Cards keep their own height: a short to-do list doesn't stretch to the orders list. */}
      <div className="grid items-start gap-4 lg:grid-cols-3">
        {canSeeOrders ? (
          <Card className="min-w-0 lg:col-span-2">
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>{t("recentOrders")}</CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/admin/orders">{t("viewAll")}</Link>
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              {summaryError && !recentOrders ? (
                <div className="px-4 pb-4">{summaryError}</div>
              ) : !recentOrders ? (
                <RecentOrdersSkeleton />
              ) : recentOrders.length === 0 ? (
                <p className="px-4 pb-4 text-body text-muted-foreground">{t("noOrders")}</p>
              ) : (
                <ul className="divide-y border-t">
                  {recentOrders.map((order) => {
                    const placed = unixToDate(order.createdAt);
                    return (
                      <li key={order.id}>
                        <Link
                          to="/admin/orders/$orderId"
                          params={{ orderId: order.id }}
                          className="flex min-h-11 items-center gap-3 px-4 py-2 text-body hover:bg-muted md:min-h-10"
                        >
                          <span className="min-w-0 flex-1">
                            <span title={`${formatOrderNumber(order.orderNumber, order.id)} · ${order.customerName}`} className="block truncate font-medium">
                              {formatOrderNumber(order.orderNumber, order.id)} · {order.customerName}
                            </span>
                            <span className="block text-muted-foreground">
                              {placed ? formatDateTime(placed, { dateStyle: "medium", timeStyle: "short" }) : null}
                            </span>
                          </span>
                          <Badge variant={statusBadgeVariant(order.status, "order")}>{orderStatusLabel(to, order.status)}</Badge>
                          <span className="tabular-nums">{fmt(order.totalAmount)}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>{t("toDo")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {openCount > 0 ? (
              <TodoLink to="/admin/orders" search={{ view: "unfulfilled" }} icon={<Inbox className="h-4 w-4" />}>
                {openCount === 1 && !openOrders.data?.pagination.totalIsCapped
                  ? t("orderToFulfil")
                  // The count stops at the API's cap: "1,000+ orders to fulfil".
                  : t("ordersToFulfil", { count: openOrders.data?.pagination.totalIsCapped ? `${formatNumber(openCount)}+` : openCount })}
              </TodoLink>
            ) : null}
            {overdueCount > 0 ? (
              <TodoLink to="/admin/orders" search={{ view: "overdue" }} icon={<CalendarClock className="h-4 w-4" />}>
                {overdueCount === 1 && !overdueInvoices.data?.pagination.totalIsCapped
                  ? t("overdueInvoiceOne")
                  : t("overdueInvoices", { count: overdueInvoices.data?.pagination.totalIsCapped ? `${formatNumber(overdueCount)}+` : overdueCount })}
              </TodoLink>
            ) : null}
            {lowCount > 0 ? (
              <TodoLink to="/admin/inventory" search={{ section: "alerts" }} icon={<Package className="h-4 w-4" />}>
                {lowCount === 1 ? t("lowStockOne") : t("lowStock", { count: lowCount })}
              </TodoLink>
            ) : null}
            {feedGaps > 0 ? (
              <TodoLink to="/admin/online-store/preferences" icon={<ImageOff className="h-4 w-4" />}>
                {feedGaps === 1 ? t("notInFeedOne") : t("notInFeed", { count: feedGaps })}
              </TodoLink>
            ) : null}
            {needsHeaderMenu ? (
              <TodoLink to="/admin/online-store/navigation" icon={<Menu className="h-4 w-4" />}>
                {t("addHeaderMenu")}
              </TodoLink>
            ) : null}
            {onlinePaymentBlocked > 0 ? (
              <TodoLink to="/admin/settings/payments" icon={<CreditCard className="h-4 w-4" />}>
                {onlinePaymentBlocked >= ONLINE_PAID_PRODUCT_COUNT_CAP
                  ? t("onlinePaymentNeededMany", { count: `${formatNumber(ONLINE_PAID_PRODUCT_COUNT_CAP)}+` })
                  : t("onlinePaymentNeeded", { count: onlinePaymentBlocked })}
              </TodoLink>
            ) : null}
            {smsBlocked ? (
              <TodoLink to="/admin/settings/notifications" icon={<TriangleAlert className="h-4 w-4" />}>
                {t("smsCannotSend", { reason: sms.data?.activeProviderError ?? "" })}
              </TodoLink>
            ) : null}
            {caughtUp ? <p className="text-body text-muted-foreground">{t("allDone")}</p> : null}
          </CardContent>
        </Card>
      </div>

      {/* Active apps' widgets, each isolated and loaded once in view. */}
      <AppHomeWidgets />
    </div>
  );
}

/** Recent orders' rows before the summary arrives: the list's own row height. */
function RecentOrdersSkeleton() {
  return (
    <ul aria-busy="true" className="divide-y border-t">
      {[0, 1, 2, 3, 4].map((row) => (
        <li key={row} className="flex min-h-11 items-center gap-3 px-4 py-2 md:min-h-10">
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-16" />
        </li>
      ))}
    </ul>
  );
}

function Metric({ label, value, change }: { label: string; value: string; change?: number | null }) {
  const t = useMessages(homeMessages);
  return (
    <Card>
      <CardHeader className="space-y-1">
        <p className="text-body text-muted-foreground">{label}</p>
        {/* Big numbers (৳10,00,000+) shrink on narrow cards instead of spilling out. */}
        <p className="text-heading-lg font-semibold tabular-nums wrap-anywhere sm:text-heading-xl">{value}</p>
        {/* Compare only against a real baseline: no badge when last month had nothing. */}
        {typeof change === "number" ? (
          <p className="text-body text-muted-foreground">
            {t("vsLastMonth", { change: `${formatNumber(Math.round(change), { signDisplay: "exceptZero" })}%` })}
          </p>
        ) : null}
      </CardHeader>
    </Card>
  );
}

function TodoLink({ to, search, icon, children }: { to: string; search?: Record<string, string>; icon: ReactNode; children: ReactNode }) {
  return (
    <Link to={to} search={search as never} className="flex min-h-11 items-center gap-3 rounded-md px-2 text-body font-medium hover:bg-muted">
      {icon}
      <span className="flex-1">{children}</span>
      <ChevronRight className="h-4 w-4 text-muted-foreground" />
    </Link>
  );
}
