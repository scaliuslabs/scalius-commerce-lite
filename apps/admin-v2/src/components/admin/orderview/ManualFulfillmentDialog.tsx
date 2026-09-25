import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
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
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { resourceMessages } from "~/i18n/resource";
import { orderErrorMessage, useCreateFulfillment } from "~/lib/api-mutations/orders";
import { formatSavedMajorAmount, resolveSavedOrderMoneySummary } from "~/lib/order-tax-presentation";
import { clampQuantity, getOrderItemName } from "./order-returns/shared";
import { canHandOver, counterCashDue, lineFulfillmentType, unfulfilledUnits } from "./fulfilment-groups";
import { formatCurrencyAmount } from "./formatters";
import { LineProperties } from "./LineProperties";
import type { Order, OrderItem } from "./types";

export type ManualFulfillmentKind = "ship" | "pickup" | "service";

/** Units of a line not handed to a courier yet (ship lines only). */
export function remainingToSend(item: OrderItem): number {
  return lineFulfillmentType(item) === "ship" ? unfulfilledUnits(item) : 0;
}

export function canSendWithOwnCourier(order: Order): boolean {
  return canHandOver(order) && order.items.some((item) => remainingToSend(item) > 0);
}

type FieldErrors = Partial<Record<"items" | "trackingUrl" | "amount", string>>;

const COPY = {
  ship: { title: "fulfill.title", help: "fulfill.help", submit: "fulfill.submit", done: "fulfill.alreadySent", left: "fulfill.left", quantity: "fulfill.quantity" },
  pickup: { title: "pickup.title", help: "pickup.help", submit: "pickup.submit", done: "pickup.alreadyCollected", left: "pickup.left", quantity: "pickup.quantity" },
  service: { title: "service.title", help: "service.help", submit: "service.submit", done: "service.alreadyDone", left: "service.left", quantity: "service.quantity" },
} as const;

/**
 * Manual hand-over with line quantities, one dialog for every kind staff
 * fulfil by hand: "Mark as sent" (own rider, with tracking), "Mark as picked
 * up" and "Mark as done" (with the cash taken at the counter or the visit).
 */
export function ManualFulfillmentDialog({ order, kind = "ship", open, onOpenChange }: {
  order: Order;
  kind?: ManualFulfillmentKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(orderDetailMessages);
  const r = useMessages(resourceMessages);
  const copy = COPY[kind];
  const canRecordCash = useOrderActionPermissions().canUpdateOrderCod;
  const items = order.items.filter((item) => lineFulfillmentType(item) === kind);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [courierName, setCourierName] = useState("");
  const [trackingId, setTrackingId] = useState("");
  const [trackingUrl, setTrackingUrl] = useState("");
  const [shipmentAmount, setShipmentAmount] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [cashTaken, setCashTaken] = useState(true);
  const [errors, setErrors] = useState<FieldErrors>({});
  // One key per opened dialog: a double click or retry replays the first fulfilment.
  const requestKey = useRef("");
  const mutation = useCreateFulfillment();
  const saved = resolveSavedOrderMoneySummary(order);
  const cashDue = kind === "ship" || !canRecordCash ? null : counterCashDue(order);
  const money = (amount: number) => (saved ? formatSavedMajorAmount(amount, saved) : formatCurrencyAmount(amount, order.currencyCode ?? "BDT"));

  useEffect(() => {
    if (!open) return;
    setQuantities(Object.fromEntries(items.map((item) => [item.id, unfulfilledUnits(item)])));
    setCourierName("");
    setTrackingId("");
    setTrackingUrl("");
    setShipmentAmount(null);
    setNote("");
    setCashTaken(true);
    setErrors({});
    requestKey.current = crypto.randomUUID();
    mutation.reset();
    // Every opening starts from what is left to hand over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const lines = items
    .map((item) => ({ itemId: item.id, quantity: quantities[item.id] ?? 0 }))
    .filter((line) => line.quantity > 0);
  const remainingTotal = items.reduce((sum, item) => sum + unfulfilledUnits(item), 0);
  const sendingTotal = lines.reduce((sum, line) => sum + line.quantity, 0);
  const firstOpenId = items.find((item) => unfulfilledUnits(item) > 0)?.id;

  const validate = (): FieldErrors => {
    const next: FieldErrors = {};
    if (lines.length === 0) next.items = t("fulfill.selectItem");
    if (kind === "ship") {
      const url = trackingUrl.trim();
      if (url && !/^https:\/\/[^\s/]+\.[^\s]+$/i.test(url)) next.trackingUrl = t("fulfill.trackingUrlInvalid");
      const amount = shipmentAmount ?? 0;
      if (!Number.isFinite(amount) || amount < 0) next.amount = t("fulfill.amountInvalid");
    }
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
    const tracking = {
      ...(courierName.trim() ? { courierName: courierName.trim() } : {}),
      ...(trackingId.trim() ? { trackingId: trackingId.trim() } : {}),
      ...(trackingUrl.trim() ? { trackingUrl: trackingUrl.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(shipmentAmount !== null ? { shipmentAmount } : {}),
    };
    mutation.mutate(
      {
        orderId: order.id,
        requestKey: requestKey.current,
        kind,
        lines,
        ...(kind === "ship" && Object.keys(tracking).length > 0 ? { tracking } : {}),
        ...(cashDue !== null && cashTaken ? { cashReceived: cashDue } : {}),
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
          <DialogTitle>{t(copy.title)}</DialogTitle>
          <DialogDescription>{t(copy.help)}</DialogDescription>
        </DialogHeader>
        <form id="manual-fulfillment" method="post" className="space-y-4" onSubmit={handleSubmit} noValidate>
          {mutation.isError ? <Alert variant="destructive"><AlertDescription>{orderErrorMessage(mutation.error)}</AlertDescription></Alert> : null}
          <div role="group" aria-labelledby="fulfill-items-label" className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p id="fulfill-items-label" className="text-body font-medium">{t("fulfill.items")}</p>
              <span className="text-muted-foreground tabular-nums">
                {t("fulfill.sending", { count: sendingTotal, total: remainingTotal })}
              </span>
            </div>
            <ul className="divide-y rounded-lg border">
              {items.map((item) => {
                const left = unfulfilledUnits(item);
                const name = getOrderItemName(item);
                return (
                  <li key={item.id} className="flex items-center gap-3 px-3 py-2 text-body">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{name}</p>
                      <LineProperties item={item} money={money} />
                      <p className="text-muted-foreground">
                        {left > 0 ? t(copy.left, { count: left }) : t(copy.done)}
                      </p>
                    </div>
                    {left > 0 ? (
                      <NumberInput
                        id={item.id === firstOpenId ? "fulfill-items" : undefined}
                        integer
                        className="w-20 shrink-0"
                        aria-label={t(copy.quantity, { name })}
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
          {kind === "ship" ? (
            <>
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
            </>
          ) : null}
          {cashDue !== null ? (
            <div className="flex items-start gap-3">
              <span className="flex h-lh items-center">
                <Checkbox
                  id="fulfill-cash"
                  checked={cashTaken}
                  disabled={mutation.isPending}
                  onCheckedChange={(value) => setCashTaken(value === true)}
                  aria-describedby="fulfill-cash-help"
                />
              </span>
              <div className="space-y-1">
                <Label htmlFor="fulfill-cash"><span className="tabular-nums">{t("handover.cashReceived", { amount: money(cashDue) })}</span></Label>
                <p id="fulfill-cash-help" className="text-muted-foreground">{t(cashTaken ? "handover.cashHelp" : "handover.cashLaterHelp")}</p>
              </div>
            </div>
          ) : null}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            {r("cancel")}
          </Button>
          <Button type="submit" form="manual-fulfillment" loading={mutation.isPending}>
            {t(copy.submit)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
