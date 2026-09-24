import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { NumberInput } from "~/components/ui/number-input";
import { MoneyInput } from "~/components/admin/shared/MoneyInput";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { resourceMessages } from "~/i18n/resource";
import { orderErrorMessage, useCreateFulfillmentShipment } from "~/lib/api-mutations/orders";
import { clampQuantity, getOrderItemName } from "./order-returns/shared";
import type { Order, OrderItem } from "./types";

const SENDABLE_ORDER_STATUSES = new Set(["confirmed", "shipped", "delivered"]);

/** Units of a line not handed to a courier yet. */
export function remainingToSend(item: OrderItem): number {
  return Math.max(0, item.quantity - (item.shippedQuantity ?? 0));
}

export function canSendWithOwnCourier(order: Order): boolean {
  return SENDABLE_ORDER_STATUSES.has(order.status.toLowerCase())
    && order.items.some((item) => remainingToSend(item) > 0)
    && !order.activeRefundOperation?.active
    && order.shipmentRecovery?.activeLock !== true
    && !order.archivedAt;
}

type FieldErrors = Partial<Record<"items" | "trackingUrl" | "amount", string>>;

/** Own-courier "Mark as sent": how many of each item your rider is taking. */
export function ManualFulfillmentDialog({ order, open, onOpenChange }: {
  order: Order;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(orderDetailMessages);
  const r = useMessages(resourceMessages);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [courierName, setCourierName] = useState("");
  const [trackingId, setTrackingId] = useState("");
  const [trackingUrl, setTrackingUrl] = useState("");
  const [shipmentAmount, setShipmentAmount] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  // One key per opened dialog: a double click or retry replays the first shipment.
  const requestKey = useRef("");
  const mutation = useCreateFulfillmentShipment();

  useEffect(() => {
    if (!open) return;
    setQuantities(Object.fromEntries(order.items.map((item) => [item.id, remainingToSend(item)])));
    setCourierName("");
    setTrackingId("");
    setTrackingUrl("");
    setShipmentAmount(null);
    setNote("");
    setErrors({});
    requestKey.current = crypto.randomUUID();
    mutation.reset();
    // Every opening starts from what is left to send.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const lines = order.items
    .map((item) => ({ itemId: item.id, quantity: quantities[item.id] ?? 0 }))
    .filter((line) => line.quantity > 0);
  const remainingTotal = order.items.reduce((sum, item) => sum + remainingToSend(item), 0);
  const sendingTotal = lines.reduce((sum, line) => sum + line.quantity, 0);
  const firstSendableId = order.items.find((item) => remainingToSend(item) > 0)?.id;

  const validate = (): FieldErrors => {
    const next: FieldErrors = {};
    if (lines.length === 0) next.items = t("fulfill.selectItem");
    const url = trackingUrl.trim();
    if (url && !/^https:\/\/[^\s/]+\.[^\s]+$/i.test(url)) next.trackingUrl = t("fulfill.trackingUrlInvalid");
    const amount = shipmentAmount ?? 0;
    if (!Number.isFinite(amount) || amount < 0) next.amount = t("fulfill.amountInvalid");
    return next;
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = validate();
    setErrors(next);
    const first = Object.keys(next)[0];
    if (first) {
      document.getElementById(`fulfill-${first}`)?.focus();
      return;
    }
    mutation.mutate(
      {
        orderId: order.id,
        requestKey: requestKey.current,
        items: lines,
        courierName: courierName.trim() || undefined,
        trackingId: trackingId.trim() || undefined,
        trackingUrl: trackingUrl.trim() || undefined,
        note: note.trim() || undefined,
        shipmentAmount: shipmentAmount ?? undefined,
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  const blur = (field: keyof FieldErrors) => setErrors((current) => ({ ...current, [field]: validate()[field] }));
  // A corrected field loses its error as soon as it changes.
  const clearError = (field: keyof FieldErrors) => setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));

  return (
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("fulfill.title")}</DialogTitle>
          <DialogDescription>{t("fulfill.help")}</DialogDescription>
        </DialogHeader>
        <form id="manual-fulfillment" method="post" className="space-y-4" onSubmit={handleSubmit} noValidate>
          {mutation.isError ? <Alert variant="destructive">{orderErrorMessage(mutation.error)}</Alert> : null}
          <div role="group" aria-labelledby="fulfill-items-label" className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p id="fulfill-items-label" className="text-body font-medium">{t("fulfill.items")}</p>
              <span className="text-muted-foreground tabular-nums">
                {t("fulfill.sending", { count: sendingTotal, total: remainingTotal })}
              </span>
            </div>
            <ul className="divide-y rounded-lg border">
              {order.items.map((item) => {
                const left = remainingToSend(item);
                const name = getOrderItemName(item);
                return (
                  <li key={item.id} className="flex items-center gap-3 px-3 py-2 text-body">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{name}</p>
                      <p className="text-muted-foreground">
                        {left > 0 ? t("fulfill.left", { count: left }) : t("fulfill.alreadySent")}
                      </p>
                    </div>
                    {left > 0 ? (
                      <NumberInput
                        id={item.id === firstSendableId ? "fulfill-items" : undefined}
                        integer
                        className="w-20 shrink-0"
                        aria-label={t("fulfill.quantity", { name })}
                        aria-invalid={Boolean(errors.items) || undefined}
                        aria-describedby={errors.items ? "fulfill-items-error" : undefined}
                        value={quantities[item.id] ?? 0}
                        disabled={mutation.isPending}
                        onValueChange={(value) => {
                          setQuantities((current) => ({
                            ...current,
                            [item.id]: clampQuantity(value, left),
                          }));
                          clearError("items");
                        }}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {errors.items ? <p id="fulfill-items-error" className="text-destructive">{errors.items}</p> : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="fulfill-courier">{t("shipments.courier")}</Label>
              <Input id="fulfill-courier" value={courierName} placeholder={t("fulfill.defaultCourier")} onChange={(e) => setCourierName(e.target.value)} disabled={mutation.isPending} autoComplete="off" maxLength={120} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="fulfill-tracking">{t("shipments.trackingId")}</Label>
              <Input id="fulfill-tracking" value={trackingId} onChange={(e) => setTrackingId(e.target.value)} disabled={mutation.isPending} autoComplete="off" maxLength={180} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="fulfill-trackingUrl">{t("fulfill.trackingUrl")}</Label>
              <Input
                id="fulfill-trackingUrl"
                type="url"
                inputMode="url"
                placeholder="https://"
                value={trackingUrl}
                aria-invalid={Boolean(errors.trackingUrl) || undefined}
                aria-describedby={errors.trackingUrl ? "fulfill-trackingUrl-error" : undefined}
                onChange={(e) => {
                  setTrackingUrl(e.target.value);
                  clearError("trackingUrl");
                }}
                onBlur={() => blur("trackingUrl")}
                disabled={mutation.isPending}
                autoComplete="off"
              />
              {errors.trackingUrl ? <p id="fulfill-trackingUrl-error" className="text-destructive">{errors.trackingUrl}</p> : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="fulfill-amount">{t("fulfill.amount")}</Label>
              <MoneyInput
                currencyCode={order.currencyCode ?? ""}
                id="fulfill-amount"
                value={shipmentAmount}
                aria-invalid={Boolean(errors.amount) || undefined}
                aria-describedby={errors.amount ? "fulfill-amount-error" : "fulfill-amount-help"}
                onValueChange={(value) => {
                  setShipmentAmount(value);
                  clearError("amount");
                }}
                onBlur={() => blur("amount")}
                disabled={mutation.isPending}
              />
              {errors.amount
                ? <p id="fulfill-amount-error" className="text-destructive">{errors.amount}</p>
                : <p id="fulfill-amount-help" className="text-muted-foreground">{t("fulfill.amountHelp")}</p>}
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="fulfill-note">{t("fulfill.note")}</Label>
            <Textarea id="fulfill-note" value={note} onChange={(e) => setNote(e.target.value)} disabled={mutation.isPending} maxLength={500} />
          </div>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            {r("cancel")}
          </Button>
          <Button type="submit" form="manual-fulfillment" loading={mutation.isPending}>
            {t("fulfill.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
