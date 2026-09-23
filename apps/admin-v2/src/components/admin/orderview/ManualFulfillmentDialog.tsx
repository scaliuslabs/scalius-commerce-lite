import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { resourceMessages } from "~/i18n/resource";
import { useCreateFulfillmentShipment } from "~/lib/api-mutations/orders";
import { getOrderItemName } from "./order-returns/shared";
import type { Order, OrderItem } from "./types";

const FULFILLMENT_READY_ORDER_STATUSES = new Set(["confirmed", "shipped"]);
const FULFILLABLE_ITEM_STATUSES = new Set(["pending", "picked", "packed"]);

function isFulfillable(item: OrderItem) {
  return FULFILLABLE_ITEM_STATUSES.has((item.fulfillmentStatus ?? "pending").toLowerCase());
}

function optional(value: string) {
  return value.trim() || undefined;
}

/** Own-courier fulfillment: pick the items handed to your own rider. */
export function ManualFulfillmentDialog({ order }: { order: Order }) {
  const t = useMessages(orderDetailMessages);
  const r = useMessages(resourceMessages);
  const canManage = useOrderActionPermissions().canManageOrderShipments;
  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [courierName, setCourierName] = useState(() => t("fulfill.defaultCourier"));
  const [trackingId, setTrackingId] = useState("");
  const [trackingUrl, setTrackingUrl] = useState("");
  const [shipmentAmount, setShipmentAmount] = useState("");
  const [note, setNote] = useState("");
  const mutation = useCreateFulfillmentShipment();
  const refundLocked = Boolean(order.activeRefundOperation?.active);
  const shipmentLocked = order.shipmentRecovery?.activeLock === true;
  const fulfillableIds = useMemo(() => order.items.filter(isFulfillable).map((item) => item.id), [order.items]);
  const canCreate = canManage
    && FULFILLMENT_READY_ORDER_STATUSES.has(order.status.toLowerCase())
    && fulfillableIds.length > 0
    && !refundLocked
    && !shipmentLocked;
  const isFinalShipment = selectedIds.length > 0 && selectedIds.length === fulfillableIds.length;

  useEffect(() => {
    if (open) setSelectedIds(fulfillableIds);
  }, [fulfillableIds, open]);

  const toggle = (item: OrderItem, checked: boolean) => {
    if (!isFulfillable(item)) return;
    setSelectedIds((current) => (checked ? [...new Set([...current, item.id])] : current.filter((id) => id !== item.id)));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage) return void toast.error(r("readOnly"));
    if (refundLocked) return void toast.error(t("locked.refund"));
    if (shipmentLocked) return void toast.error(t("locked.shipment"));
    if (selectedIds.length === 0) return void toast.error(t("fulfill.selectItem"));
    const amount = shipmentAmount.trim() ? Number(shipmentAmount) : undefined;
    if (amount !== undefined && (!Number.isFinite(amount) || amount < 0)) {
      return void toast.error(t("fulfill.amountInvalid"));
    }
    mutation.mutate(
      {
        orderId: order.id,
        itemIds: selectedIds,
        courierName: optional(courierName),
        trackingId: optional(trackingId),
        trackingUrl: optional(trackingUrl),
        note: optional(note),
        shipmentAmount: amount,
        isFinalShipment,
      },
      { onSuccess: () => setOpen(false) },
    );
  };

  const blockedReason = canCreate
    ? undefined
    : !canManage ? r("readOnly")
      : refundLocked ? t("locked.refund")
        : shipmentLocked ? t("locked.shipment")
          : t("fulfill.confirmFirst");

  return (
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && setOpen(next)}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" className="w-full" disabled={!canCreate} title={blockedReason}>
          {t("fulfill.open")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("fulfill.title")}</DialogTitle>
          <DialogDescription>{t("fulfill.help")}</DialogDescription>
        </DialogHeader>
        <form method="post" className="space-y-4" onSubmit={handleSubmit} noValidate>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-body font-medium">{t("fulfill.items")}</p>
              <Badge variant={isFinalShipment ? "secondary" : "outline"}>
                {isFinalShipment ? t("fulfill.final") : t("fulfill.partial")}
              </Badge>
            </div>
            <ul className="divide-y rounded-md border">
              {order.items.map((item) => (
                <li key={item.id} className="flex items-start gap-3 px-3 py-2 text-body">
                  <Checkbox
                    id={`fulfill-item-${item.id}`}
                    checked={selectedIds.includes(item.id)}
                    onCheckedChange={(checked) => toggle(item, checked === true)}
                    disabled={!isFulfillable(item) || mutation.isPending}
                  />
                  <Label htmlFor={`fulfill-item-${item.id}`} className="min-w-0 flex-1">
                    {getOrderItemName(item)} × {item.quantity}
                  </Label>
                  {!isFulfillable(item) ? <Badge variant="outline">{t("fulfill.alreadySent")}</Badge> : null}
                </li>
              ))}
            </ul>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="fulfill-courier">{t("shipments.courier")}</Label>
              <Input id="fulfill-courier" value={courierName} onChange={(e) => setCourierName(e.target.value)} disabled={mutation.isPending} autoComplete="off" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="fulfill-tracking">{t("shipments.trackingId")}</Label>
              <Input id="fulfill-tracking" value={trackingId} onChange={(e) => setTrackingId(e.target.value)} disabled={mutation.isPending} autoComplete="off" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="fulfill-tracking-url">{t("fulfill.trackingUrl")}</Label>
              <Input id="fulfill-tracking-url" type="url" value={trackingUrl} onChange={(e) => setTrackingUrl(e.target.value)} disabled={mutation.isPending} autoComplete="off" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="fulfill-amount">{t("fulfill.amount")}</Label>
              <Input id="fulfill-amount" type="number" inputMode="decimal" min="0" step="0.01" value={shipmentAmount} onChange={(e) => setShipmentAmount(e.target.value)} disabled={mutation.isPending} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="fulfill-note">{t("fulfill.note")}</Label>
            <Textarea id="fulfill-note" value={note} onChange={(e) => setNote(e.target.value)} disabled={mutation.isPending} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={mutation.isPending}>
              {r("cancel")}
            </Button>
            <Button type="submit" disabled={mutation.isPending || selectedIds.length === 0 || !canCreate}>
              {t("fulfill.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
