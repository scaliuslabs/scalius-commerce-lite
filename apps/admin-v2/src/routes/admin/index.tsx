import type { ReactNode } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, CreditCard, ImageOff, Inbox, Menu, Package, Palette, Store, Truck } from "lucide-react";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { unixToDate } from "@scalius/shared/timestamps";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { statusBadgeVariant } from "~/components/admin/orderview/status-badges";
import { orderMessages, orderStatusLabel } from "~/i18n/orders";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { DashboardSalesChart } from "~/components/admin/DashboardSalesChart";
import { usePermissions } from "~/contexts/PermissionContext";
import { useCurrency } from "~/hooks/use-currency";
import { canAccessAdminPath } from "~/lib/admin-access";
import { RouteErrorComponent } from "~/lib/route-error";
import {
  HOME_FEED_STALE_TIME_MS,
  dashboardActivityQueryOptions,
  dashboardSummaryQueryOptions,
  homeLowStockQueryOptions,
  homeOpenOrdersQueryOptions,
} from "~/lib/api-query-options/dashboard-home";
import { currencySettingsQueryOptions } from "~/lib/api-query-options/currency";
import { countFeedGaps, feedDiagnosticsQueryOptions, navigationPlacementsQueryOptions } from "~/lib/api-query-options/online-store";
import { formatDateTime, formatNumber, useMessages } from "~/i18n";
import { homeMessages } from "~/i18n/home";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/")({
  // Every Home read starts here, in one round trip, rather than after the
  // page's code has loaded and rendered.
  loader: ({ context: { queryClient, permissions, isSuperAdmin } }) => {
    const canOpen = (to: string) => canAccessAdminPath(to, { permissions, isSuperAdmin });
    void queryClient.prefetchQuery(dashboardSummaryQueryOptions());
    void queryClient.prefetchQuery(dashboardActivityQueryOptions());
    void queryClient.prefetchQuery(currencySettingsQueryOptions());
    if (canOpen("/admin/orders")) void queryClient.prefetchQuery(homeOpenOrdersQueryOptions());
    if (canOpen("/admin/inventory")) void queryClient.prefetchQuery(homeLowStockQueryOptions());
    if (canOpen("/admin/online-store/preferences")) void queryClient.prefetchQuery({ ...feedDiagnosticsQueryOptions(), staleTime: HOME_FEED_STALE_TIME_MS });
    if (canOpen("/admin/online-store/navigation")) void queryClient.prefetchQuery(navigationPlacementsQueryOptions());
  },
  head: () => pageHead("home"),
  errorComponent: RouteErrorComponent,
  component: HomePage,
});

type HomeKey = keyof (typeof homeMessages)["en"];

/** Today's date in store time (Asia/Dhaka) as YYYY-MM-DD, matching the activity feed. */
const storeToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(new Date());

function HomePage() {
  const t = useMessages(homeMessages);
  const to = useMessages(orderMessages);
  const { fmt } = useCurrency();
  const { permissions, isSuperAdmin } = usePermissions();
  const canOpen = (to: string) => canAccessAdminPath(to, { permissions, isSuperAdmin });
  const summary = useQuery(dashboardSummaryQueryOptions());
  const activity = useQuery(dashboardActivityQueryOptions());
  const openOrders = useQuery({ ...homeOpenOrdersQueryOptions(), enabled: canOpen("/admin/orders") });
  const lowStock = useQuery({ ...homeLowStockQueryOptions(), enabled: canOpen("/admin/inventory") });
  // Store readiness (Shopify's Home tasks): products the product feed leaves
  // out for a fixable reason, and a storefront header without a menu.
  const feed = useQuery({
    ...feedDiagnosticsQueryOptions(),
    enabled: canOpen("/admin/online-store/preferences"),
    staleTime: HOME_FEED_STALE_TIME_MS,
  });
  const placements = useQuery({ ...navigationPlacementsQueryOptions(), enabled: canOpen("/admin/online-store/navigation") });

  if (summary.isError) {
    return (
      <div>
        <PageHeader title={t("home")} />
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
            {t("loadFailed")}
            <Button variant="outline" size="sm" onClick={() => void summary.refetch()}>{t("retry")}</Button>
          </CardHeader>
        </Card>
      </div>
    );
  }
  if (!summary.data) return <PageHeader title={t("home")} />;

  const { stats, recentOrders } = summary.data;
  const month = stats.currentMonth;
  if (stats.totalProducts === 0 && month.orders === 0 && recentOrders.length === 0) return <SetupCards canOpen={canOpen} />;

  // The API sends no money to roles without "View sales numbers": order counts only.
  const sales = month.revenue !== null;
  const canSeeOrders = canOpen("/admin/orders");
  const days = (activity.data?.dailyActivityData ?? [])
    .slice(-30)
    .map((day) => ({ ...day, revenue: day.revenue ?? 0 }));
  const today = days.find((day) => day.date === storeToday());
  const openCount = openOrders.data?.pagination.total ?? 0;
  const lowCount = lowStock.data?.alerts.length ?? 0;
  const feedGaps = countFeedGaps(feed.data);
  const needsHeaderMenu = placements.data !== undefined && !placements.data.some(({ placement, menuDeletedAt, publicationItemCount }) =>
    placement.surface === "header" && placement.isEnabled && !menuDeletedAt && (publicationItemCount ?? 0) > 0);
  const caughtUp = openCount === 0 && lowCount === 0 && feedGaps === 0 && !needsHeaderMenu;

  return (
    <div className="space-y-4 pb-8">
      <PageHeader title={t("home")} />
      <div className={sales ? "grid grid-cols-2 gap-3 lg:grid-cols-4" : "grid grid-cols-2 gap-3"}>
        {sales ? <Metric label={t("salesToday")} value={fmt(today?.revenue ?? 0)} /> : null}
        <Metric label={t("ordersToday")} value={formatNumber(today?.orders ?? 0)} />
        {sales ? <Metric label={t("salesThisMonth")} value={fmt(month.revenue ?? 0)} change={month.revenueGrowth} /> : null}
        <Metric label={t("ordersThisMonth")} value={formatNumber(month.orders)} change={month.orderGrowth} />
      </div>

      {sales ? (
        <Card>
          <CardHeader className="space-y-1">
            <CardTitle>{t("salesChart")}</CardTitle>
            <p className="text-body text-muted-foreground">{t("grossHelp")}</p>
          </CardHeader>
          <CardContent>
            {days.some((day) => day.revenue > 0) ? (
              <DashboardSalesChart days={days} money={fmt} />
            ) : (
              <p className="py-8 text-center text-body text-muted-foreground">{t("noSalesYet")}</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <p className="text-body text-muted-foreground">{t("noSalesAccess")}</p>
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
              {recentOrders.length === 0 ? (
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
                            <span className="block truncate font-medium">
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
                {openCount === 1 ? t("orderToFulfil") : t("ordersToFulfil", { count: openCount })}
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
            {caughtUp ? <p className="text-body text-muted-foreground">{t("allDone")}</p> : null}
          </CardContent>
        </Card>
      </div>
    </div>
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

const SETUP: ReadonlyArray<{ to: string; icon: typeof Package; title: HomeKey; body: HomeKey; action: HomeKey }> = [
  { to: "/admin/products/new", icon: Package, title: "setupProduct", body: "setupProductBody", action: "setupProductAction" },
  { to: "/admin/online-store/theme", icon: Palette, title: "setupTheme", body: "setupThemeBody", action: "setupThemeAction" },
  { to: "/admin/settings/payments", icon: CreditCard, title: "setupPayments", body: "setupPaymentsBody", action: "setupPaymentsAction" },
  { to: "/admin/settings/store", icon: Store, title: "setupStore", body: "setupStoreBody", action: "setupStoreAction" },
  { to: "/admin/settings/shipping", icon: Truck, title: "setupShipping", body: "setupShippingBody", action: "setupShippingAction" },
];

/** A store with no products and no orders yet: Shopify's setup cards. */
function SetupCards({ canOpen }: { canOpen: (to: string) => boolean }) {
  const t = useMessages(homeMessages);
  return (
    <div className="mx-auto max-w-3xl space-y-4 pb-8">
      <div>
        <h1 className="text-heading-lg font-semibold">{t("welcome")}</h1>
        <p className="text-body text-muted-foreground">{t("welcomeBody")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {SETUP.filter((step) => canOpen(step.to)).map((step) => (
          <Card key={step.to}>
            <CardHeader className="space-y-3">
              <step.icon className="h-5 w-5 text-muted-foreground" />
              <div>
                <h2 className="font-semibold">{t(step.title)}</h2>
                <p className="text-body text-muted-foreground">{t(step.body)}</p>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link to={step.to}>{t(step.action)}</Link>
              </Button>
            </CardHeader>
          </Card>
        ))}
      </div>
    </div>
  );
}
