import { useMemo, useState } from "react";
import { createFileRoute, Link, Outlet, useMatch, useNavigate } from "@tanstack/react-router";
import { Download } from "lucide-react";
import { Button } from "~/components/ui/button";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { IndexTabs } from "~/components/admin/resource/IndexTabs";
import { OrderExportContext } from "~/components/admin/order-list/order-export";
import {
  ORDER_VIEWS,
  orderViewUpdates,
  type OrderView,
} from "~/components/admin/order-list/order-list-search";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useRememberOrderListHref } from "~/components/admin/order-list/use-remember-order-list";
import { useMessages } from "~/i18n";
import { orderMessages } from "~/i18n/orders";
import { resourceMessages } from "~/i18n/resource";
import { orderListMessages } from "~/i18n/order-list";

/** Orders frame: one header and one card whose tabs switch between order views and abandoned checkouts. */
export const Route = createFileRoute("/admin/orders/_list")({
  component: OrdersFrame,
});

type OrdersTab = "all" | OrderView | "abandoned";

function OrdersFrame() {
  const t = useMessages(orderListMessages);
  const tr = useMessages(resourceMessages);
  const to = useMessages(orderMessages);
  const orderActions = useOrderActionPermissions();
  const navigate = useNavigate();
  const [exportOpen, setExportOpen] = useState(false);
  const exportDialog = useMemo(() => ({ open: exportOpen, setOpen: setExportOpen }), [exportOpen]);
  const search = useMatch({ from: "/admin/orders/_list/", shouldThrow: false })?.search;
  const tab: OrdersTab = search ? (search.view ?? "all") : "abandoned";
  useRememberOrderListHref();

  const selectTab = (next: OrdersTab) => {
    if (next === "abandoned") {
      void navigate({ to: "/admin/orders/abandoned" });
      return;
    }
    const updates = orderViewUpdates(next === "all" ? undefined : next);
    void navigate({ to: "/admin/orders", search: search ? { ...search, ...updates } : updates });
  };

  return (
    <OrderExportContext.Provider value={exportDialog}>
      <PageHeader
        title={tab === "abandoned" ? t("abandonedTitle") : to("orders")}
        actions={
          <>
            {search ? (
              <Button variant="outline" onClick={() => setExportOpen(true)}>
                <Download className="h-4 w-4" />
                {t("export")}
              </Button>
            ) : null}
            {orderActions.canCreateOrders ? (
              <Button asChild>
                <Link to="/admin/orders/new">{t("createOrder")}</Link>
              </Button>
            ) : null}
          </>
        }
      />
      <div className="overflow-clip rounded-xl bg-card shadow-card">
        <IndexTabs<OrdersTab>
          label={t("views")}
          value={tab}
          onChange={selectTab}
          tabs={[
            { value: "all", label: tr("all") },
            ...ORDER_VIEWS.map((view) => ({ value: view, label: t(`tab.${view}`) })),
            { value: "abandoned", label: t("tab.abandoned") },
          ]}
        />
        <Outlet />
      </div>
    </OrderExportContext.Provider>
  );
}
