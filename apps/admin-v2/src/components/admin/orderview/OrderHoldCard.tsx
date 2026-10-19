import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { useReleaseOrderHold } from "~/lib/api-mutations/orders";
import { clearOrderNotice } from "~/lib/order-notice";
import { formatOrderTimestamp, orderTimestampIso } from "./formatters";
import { openOrderHolds } from "./primary-action";
import type { Order, OrderHold } from "./types";

/**
 * An app put the order on hold for staff review (`ctx.orders.hold`): which app,
 * why and when, at the top of the page, with Release for staff who may
 * change the order's status. Shown only while a hold is open
 * (card-rules.ts); released holds are listed with the apps' risk checks in
 * the customer card. Loaded lazily (LazyOrderHoldCard): most orders never
 * carry one.
 */
export function OrderHoldCard({ order }: { order: Pick<Order, "id" | "holds"> }) {
  const t = useMessages(orderDetailMessages);
  const { canChangeOrderStatus } = useOrderActionPermissions();
  const release = useReleaseOrderHold();
  // The last hold asked about stays named while the dialog closes.
  const [target, setTarget] = useState<OrderHold | null>(null);
  const [confirming, setConfirming] = useState(false);
  const open = openOrderHolds(order);
  if (open.length === 0) return null;

  return (
    <>
      <Card role="note" aria-labelledby="order-hold-title">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle id="order-hold-title">{t("holds.title")}</CardTitle>
          <Badge variant="warning">{t("holds.badge")}</Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground">{t("holds.help")}</p>
          <ul className="space-y-3">
            {open.map((hold) => {
              const when = formatOrderTimestamp(hold.placedAt);
              return (
                <li key={hold.id} className="space-y-1">
                  <p className="flex flex-wrap items-center gap-x-2">
                    <Link to="/admin/apps/$pluginId" params={{ pluginId: hold.appId }} className="font-medium text-link hover:underline">
                      {hold.appName}
                    </Link>
                    {when ? <time dateTime={orderTimestampIso(hold.placedAt)}>{t("holds.placedAt", { when })}</time> : null}
                  </p>
                  <p className="whitespace-pre-line">{hold.reason}</p>
                  {canChangeOrderStatus ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-1"
                      loading={release.isPending && release.variables?.holdId === hold.id}
                      onClick={() => {
                        setTarget(hold);
                        setConfirming(true);
                      }}
                    >
                      {t("holds.release")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        variant="default"
        title={t("holds.releaseTitle", { app: target?.appName ?? "" })}
        description={t("holds.releaseBody", { app: target?.appName ?? "" })}
        confirmLabel={t("holds.release")}
        onConfirm={() => {
          if (!target) return;
          // An earlier "on hold" refusal no longer applies.
          clearOrderNotice(order.id);
          release.mutate({ orderId: order.id, holdId: target.id });
        }}
      />
    </>
  );
}
