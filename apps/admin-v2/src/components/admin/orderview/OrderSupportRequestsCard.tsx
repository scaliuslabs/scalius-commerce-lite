import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { NumberInput } from "~/components/ui/number-input";
import { Label } from "~/components/ui/label";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { Textarea } from "~/components/ui/textarea";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useMessages } from "~/i18n";
import { orderDetailLabel, orderDetailMessages } from "~/i18n/order-detail";
import { orderMessages } from "~/i18n/orders";
import { resourceMessages } from "~/i18n/resource";
import { orderErrorMessage, useResolveOrderSupportRequest } from "~/lib/api-mutations/orders";
import { orderReturnsQueryOptions } from "~/lib/api-query-options/orders";
import {
  StableReturnCommandKey,
  getRemainingReturnableQuantities,
  type OrderReturnDto,
} from "~/lib/order-return-workflow";
import { formatOrderTimestamp } from "./formatters";
import { createReturnCommandKey, getOrderItemName, clampQuantity } from "./order-returns/shared";
import { restockedUnits, shippedCancelReason } from "./OrderStatusCard";
import { openCancellationRequest, type OrderActionRequest } from "./primary-action";
import { statusBadgeVariant } from "./status-badges";
import type { Order, OrderSupportRequest } from "./types";

type Resolution = "under_review" | "approved" | "rejected" | "completed";
const EMPTY_RETURNS: readonly OrderReturnDto[] = [];

/**
 * Answers a merchant can give. Accepting a cancellation cancels the order,
 * so it needs the right to cancel orders.
 */
export function resolutionsFor(request: Pick<OrderSupportRequest, "status" | "type">, canCancelOrders: boolean): Resolution[] {
  const options: Resolution[] = request.status === "submitted"
    ? ["under_review", "approved", "rejected", "completed"]
    : request.status === "under_review"
      ? ["approved", "rejected", "completed"]
      : request.status === "approved" ? ["completed"] : [];
  return request.type === "cancel_pre_shipment" && !canCancelOrders
    ? options.filter((option) => option !== "approved")
    : options;
}

function ResolveDialog({
  order,
  request,
  open,
  onOpenChange,
}: {
  order: Order;
  request: OrderSupportRequest | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(orderDetailMessages);
  const o = useMessages(orderMessages);
  const r = useMessages(resourceMessages);
  const canCancelOrders = useOrderActionPermissions().canChangeOrderStatus;
  const mutation = useResolveOrderSupportRequest();
  const options = request ? resolutionsFor(request, canCancelOrders) : [];
  const [selected, setSelected] = useState<Resolution | null>(null);
  const [choiceMissing, setChoiceMissing] = useState(false);
  const [note, setNote] = useState("");
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const commandKey = useRef(new StableReturnCommandKey(createReturnCommandKey));
  const isReturnApproval = request?.type === "return" && selected === "approved";
  const returnsQuery = useQuery({ ...orderReturnsQueryOptions(order.id), enabled: open && isReturnApproval });
  const returns = returnsQuery.data?.returns ?? EMPTY_RETURNS;
  const remaining = useMemo(() => getRemainingReturnableQuantities(order.items, returns), [order.items, returns]);
  const eligibleItems = useMemo(
    () => order.items.filter((item) => (remaining.get(item.id) ?? 0) > 0),
    [order.items, remaining],
  );
  const returnLines = eligibleItems
    .map((item) => ({
      orderItemId: item.id,
      quantity: Math.min(quantities[item.id] ?? 0, remaining.get(item.id) ?? 0),
      reason: request?.reason ?? null,
    }))
    .filter((line) => line.quantity > 0);

  useEffect(() => {
    if (!open || !request) return;
    // Nothing is pre-selected: the merchant picks the answer.
    setSelected(null);
    setChoiceMissing(false);
    setNote("");
    setQuantities({});
    commandKey.current.clear();
    mutation.reset();
  }, [open, request?.id, request?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!request) return <Dialog open={false} onOpenChange={onOpenChange} />;

  const canSubmit = Boolean(selected)
    && (!isReturnApproval || (returnsQuery.isSuccess && returnLines.length > 0));
  const isCancelApproval = request.type === "cancel_pre_shipment" && selected === "approved";
  const restock = restockedUnits(order);
  const shippedReason = isCancelApproval ? shippedCancelReason(order, t) : null;

  const submit = () => {
    if (!selected) {
      setChoiceMissing(true);
      document.getElementById(`resolution-${options[0]}`)?.focus();
      return;
    }
    if (!canSubmit || shippedReason) return;
    const returnRequest = isReturnApproval
      ? { expectedOrderVersion: order.version, reason: request.reason, notes: request.message?.trim() || null, lines: returnLines }
      : null;
    mutation.mutate({
      orderId: order.id,
      requestId: request.id,
      status: selected,
      note: note.trim() || null,
      ...(returnRequest
        ? { returnRequest: { commandKey: commandKey.current.get("support-request", returnRequest), ...returnRequest } }
        : {}),
    }, {
      onSuccess: () => {
        commandKey.current.clear();
        onOpenChange(false);
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{o(`request.${request.type}`)}</DialogTitle>
          <DialogDescription>{request.reason}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {mutation.isError ? <Alert variant="destructive"><AlertDescription>{orderErrorMessage(mutation.error)}</AlertDescription></Alert> : null}
          <RadioGroup
            value={selected ?? ""}
            aria-invalid={choiceMissing || undefined}
            aria-describedby={choiceMissing ? "resolution-error" : undefined}
            onValueChange={(value) => {
              setSelected(value as Resolution);
              setChoiceMissing(false);
            }}
          >
            {options.map((option) => (
              <div key={option} className="flex items-center gap-3">
                <RadioGroupItem id={`resolution-${option}`} value={option} />
                <Label htmlFor={`resolution-${option}`}>{t(`requests.resolve.${option}`)}</Label>
              </div>
            ))}
          </RadioGroup>
          {choiceMissing ? <p id="resolution-error" className="text-destructive">{t("requests.chooseAction")}</p> : null}
          {request.type === "return" ? (
            <p className="text-body text-muted-foreground">{t("requests.returnHelp")}</p>
          ) : null}
          {shippedReason ? (
            <p className="text-body text-destructive">{shippedReason}</p>
          ) : isCancelApproval ? (
            <p className="text-body text-muted-foreground">
              {[t("requests.cancelHelp"), restock > 0 ? t("cancel.restock", { count: restock }) : null].filter(Boolean).join(" ")}
            </p>
          ) : null}

          {isReturnApproval ? (
            returnsQuery.isLoading ? (
              <p className="text-body text-muted-foreground">{t("read.loading")}</p>
            ) : returnsQuery.isError ? (
              <div className="flex items-center justify-between gap-2 text-body">
                <p className="text-muted-foreground">{t("returns.loadFailed")}</p>
                <Button type="button" size="sm" variant="outline" onClick={() => void returnsQuery.refetch()}>{r("retry")}</Button>
              </div>
            ) : eligibleItems.length === 0 ? (
              <p className="text-body text-muted-foreground">{t("requests.nothingToReturn")}</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {eligibleItems.map((item) => {
                  const max = remaining.get(item.id) ?? 0;
                  const name = getOrderItemName(item);
                  return (
                    <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2 text-body">
                      <div className="min-w-0">
                        <p className="font-medium">{name}</p>
                        <p className="text-muted-foreground">{t("returns.available", { count: max })}</p>
                      </div>
                      <NumberInput
                        integer
                        className="w-20 shrink-0"
                        aria-label={t("returns.returnQty", { name })}
                        value={quantities[item.id] ?? 0}
                        onValueChange={(value) => setQuantities((current) => ({ ...current, [item.id]: clampQuantity(value, max) }))}
                      />
                    </li>
                  );
                })}
              </ul>
            )
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="support-request-note">{t("requests.note")}</Label>
            <Textarea id="support-request-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>{r("cancel")}</Button>
          <Button
            type="button"
            variant={isCancelApproval ? "destructive" : "default"}
            onClick={submit}
            disabled={Boolean(selected) && (!canSubmit || shippedReason !== null)}
            loading={mutation.isPending}
          >
            {isCancelApproval ? t("requests.acceptCancel") : r("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function OrderSupportRequestsCard({ order, request }: { order: Order; request?: OrderActionRequest | null }) {
  const t = useMessages(orderDetailMessages);
  const o = useMessages(orderMessages);
  const actions = useOrderActionPermissions();
  const canResolve = actions.canResolveOrderSupportRequests;
  const cardRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<OrderSupportRequest | null>(null);
  const [open, setOpen] = useState(false);
  const requests = order.supportRequests ?? [];

  // "Review cancellation request" in the header opens the open request here.
  useEffect(() => {
    if (request?.action !== "reviewCancellation") return;
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    const pending = openCancellationRequest(order);
    if (!pending || !canResolve) return;
    setSelected(pending);
    setOpen(true);
    // Only a new request should open the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id]);

  if (requests.length === 0) return null;
  const openCount = requests.filter((request) => request.active).length;

  return (
    <Card ref={cardRef} id="order-requests" className="scroll-mt-4">
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>{t("requests.title")}</CardTitle>
        {openCount > 0 ? <Badge variant="outline">{t("requests.open", { count: openCount })}</Badge> : null}
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {requests.map((request) => (
            <li key={request.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{o(`request.${request.type}`)}</span>
                  <Badge variant={statusBadgeVariant(request.status)}>{orderDetailLabel(t, "requests.status.", request.status)}</Badge>
                </div>
                <p className="text-muted-foreground">{request.reason}</p>
                {request.message ? <p className="line-clamp-3 text-muted-foreground">{request.message}</p> : null}
                <p className="text-muted-foreground">{formatOrderTimestamp(request.submittedAt ?? request.createdAt)}</p>
              </div>
              {canResolve && request.active && resolutionsFor(request, actions.canChangeOrderStatus).length > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setSelected(request);
                    setOpen(true);
                  }}
                >
                  {t("requests.review")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
      <ResolveDialog order={order} request={selected} open={open} onOpenChange={setOpen} />
    </Card>
  );
}
