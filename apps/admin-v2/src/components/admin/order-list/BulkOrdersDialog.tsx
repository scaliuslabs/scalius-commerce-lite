import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import type { OrderListItem } from "@scalius/core/modules/orders/orders.types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { deliveryProvidersQueryOptions, type DeliveryProviderRecord } from "~/lib/api-query-options/delivery";
import {
  getProviderReadinessMessage,
  resolveProviderReadiness,
} from "~/components/admin/delivery-providers/ProviderIcon";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { orderMessages, orderStatusLabel } from "~/i18n/orders";
import { orderListMessages, pluralKey } from "~/i18n/order-list";
import { planOrderBulkAction, type OrderBulkAction, type OrderBulkOutcome } from "./order-bulk-actions";

export type BulkRunExtras = { courierName?: string; note?: string; providerId?: string };

interface BulkOrdersDialogProps {
  action: OrderBulkAction | null;
  /** The orders the action is about; null while "all matching orders" are still loading. */
  orders: OrderListItem[] | null;
  /** How many orders the merchant selected (all matching orders counts every one); the title's count until the orders load. */
  selectedCount: number;
  /** One extra line under the preview, e.g. that only the first 1,000 orders are included. */
  note?: string;
  running: boolean;
  outcome: OrderBulkOutcome | null;
  onOpenChange: (open: boolean) => void;
  onRun: (eligible: OrderListItem[], extras: BulkRunExtras) => void;
}

function CourierPicker({ value, onChange, disabled }: { value: string; onChange: (id: string) => void; disabled: boolean }) {
  const t = useMessages(orderListMessages);
  const { data: providers = [], isLoading } = useQuery({
    ...deliveryProvidersQueryOptions(),
    select: (data) => (Array.isArray(data) ? (data as DeliveryProviderRecord[]) : []),
  });
  const selected = providers.find((provider) => provider.id === value);
  const readiness = selected ? resolveProviderReadiness(selected) : null;
  const ready = providers.filter((provider) => resolveProviderReadiness(provider).canCreateShipment);
  return (
    <div className="space-y-2">
      <Label htmlFor="bulk-ship-courier">{t("courier")}</Label>
      <Select value={value} onValueChange={onChange} disabled={isLoading || disabled}>
        <SelectTrigger id="bulk-ship-courier">
          <SelectValue placeholder={t("chooseCourier")} />
        </SelectTrigger>
        <SelectContent>
          {providers.map((provider) => {
            const canShip = resolveProviderReadiness(provider).canCreateShipment;
            return (
              <SelectItem key={provider.id} value={provider.id} disabled={!canShip}>
                {canShip ? provider.name : t("courierNotReady", { name: provider.name })}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {!isLoading && ready.length === 0 ? (
        <p className="text-body text-muted-foreground">
          {providers.length === 0 ? t("noCouriers") : t("noReadyCouriers")}{" "}
          <Link to="/admin/settings/shipping" className="text-link hover:underline">
            {t("courierSettingsLink")}
          </Link>
        </p>
      ) : null}
      {readiness && !readiness.canCreateShipment ? (
        <p className="text-body text-destructive">{getProviderReadinessMessage(readiness)}</p>
      ) : null}
    </div>
  );
}

/**
 * Confirm, Mark as sent, Book courier and Archive (all matching orders) for a
 * selection: previews which orders will change and which are skipped, then
 * reports each order that failed by its number.
 */
export function BulkOrdersDialog({
  action,
  orders,
  selectedCount,
  note,
  running,
  outcome,
  onOpenChange,
  onRun,
}: BulkOrdersDialogProps) {
  const t = useMessages(orderListMessages);
  const tr = useMessages(resourceMessages);
  const to = useMessages(orderMessages);
  const [courierName, setCourierName] = useState("");
  const [sendNote, setSendNote] = useState("");
  const [providerId, setProviderId] = useState("");

  useEffect(() => {
    if (action === null) return;
    setCourierName("");
    setSendNote("");
  }, [action]);

  const current = action ?? "confirm";
  const plan = orders ? planOrderBulkAction(orders, current) : null;
  const eligibleCount = plan?.eligible.length ?? 0;
  const numberOf = (orderId: string) => {
    const order = orders?.find((candidate) => candidate.id === orderId);
    return formatOrderNumber(order?.orderNumber, orderId);
  };
  const visibleFailures = outcome?.failures.slice(0, 5) ?? [];
  const hiddenFailures = (outcome?.failures.length ?? 0) - visibleFailures.length;
  const blocked = !plan || eligibleCount === 0 || (current === "ship" && !providerId);
  // The title counts only the orders the action will change ("Confirm 3 orders", not the 5 selected).
  const titleCount = eligibleCount > 0 ? eligibleCount : selectedCount;

  return (
    <Dialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!running) onOpenChange(open);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(pluralKey(`bulkTitle.${current}`, titleCount), { count: titleCount })}</DialogTitle>
          <DialogDescription>
            {plan
              ? eligibleCount > 0
                ? t(pluralKey(`bulkWill.${current}`, eligibleCount), { count: eligibleCount })
                : t(`bulkNone.${current}`)
              : t("loadingOrders")}
          </DialogDescription>
        </DialogHeader>

        {note ? <p className="text-body text-muted-foreground">{note}</p> : null}
        {plan && plan.skipped.length > 0 ? (
          <ul className="space-y-1 text-body text-muted-foreground">
            {plan.skipped.map((group) => (
              <li key={group.kind === "status" ? group.status : group.reason}>
                {group.kind === "status"
                  ? t(pluralKey("skipStatus", group.count), {
                      count: group.count,
                      status: orderStatusLabel(to, group.status).toLocaleLowerCase(),
                    })
                  : `${t(pluralKey("skipBlocked", group.count), { count: group.count })} ${t(`block.${group.reason}`)}`}
              </li>
            ))}
          </ul>
        ) : null}

        {current === "send" ? (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="bulk-send-courier">{t("courierNameOptional")}</Label>
              <Input
                id="bulk-send-courier"
                value={courierName}
                maxLength={120}
                disabled={running}
                onChange={(event) => setCourierName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bulk-send-note">{t("noteOptional")}</Label>
              <Textarea
                id="bulk-send-note"
                value={sendNote}
                maxLength={500}
                disabled={running}
                onChange={(event) => setSendNote(event.target.value)}
              />
            </div>
          </div>
        ) : null}
        {current === "ship" && action !== null ? (
          <CourierPicker value={providerId} onChange={setProviderId} disabled={running} />
        ) : null}

        {outcome && outcome.failures.length > 0 ? (
          <div className="space-y-1 border-t pt-4 text-body" role="status">
            <p className="font-medium">
              {t("bulkResult", { done: outcome.succeeded.length, total: outcome.succeeded.length + outcome.failures.length })}
            </p>
            <p className="text-muted-foreground">{t(pluralKey("bulkFailedStay", outcome.failures.length), { count: outcome.failures.length })}</p>
            <ul className="space-y-1 text-muted-foreground">
              {visibleFailures.map((failure) => (
                <li key={failure.orderId} className="break-words">
                  <span className="font-medium text-foreground">{numberOf(failure.orderId)}</span>: {failure.error}
                </li>
              ))}
            </ul>
            {hiddenFailures > 0 ? <p className="text-muted-foreground">{t("moreFailed", { count: hiddenFailures })}</p> : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
            {tr("cancel")}
          </Button>
          <Button
            variant={current === "archive" ? "outline" : "default"}
            loading={running}
            disabled={blocked}
            onClick={() => {
              if (plan && !blocked && !running) onRun(plan.eligible, { courierName, note: sendNote, providerId });
            }}
          >
            {t(pluralKey(`bulkRun.${current}`, titleCount))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
