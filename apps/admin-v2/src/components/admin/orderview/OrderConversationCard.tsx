import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MessagesSquare } from "lucide-react";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
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
import { useHasPermission } from "~/contexts/PermissionContext";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useMessages } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";
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
import { inboxKeys, orderThreadQueryOptions } from "~/lib/api-query-options/inbox";
import { useMarkRead } from "../inbox/inbox-api";

// The thread and the reply box are not in the order page's first download:
// the card sits low on the page and its thread is a read of its own. Their
// code is fetched as soon as the page's code runs (warming the order page
// fetches it too), beside the order's data rather than after the card renders.
const loadConversationMessages = () => import("../inbox/ConversationMessages");
const loadConversationComposer = () => import("../inbox/ConversationComposer");
void loadConversationMessages().catch(() => {});
void loadConversationComposer().catch(() => {});
const ConversationMessages = lazy(() =>
  loadConversationMessages().then((module) => ({ default: module.ConversationMessages })),
);
const ConversationComposer = lazy(() =>
  loadConversationComposer().then((module) => ({ default: module.ConversationComposer })),
);

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
  const queryClient = useQueryClient();
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
        // The status change is a line on the order's conversation.
        void queryClient.invalidateQueries({ queryKey: inboxKeys.order(order.id) });
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

/**
 * The order's Messages card (Wave A §8.1): open requests with their answers,
 * the conversation with the customer (internal notes included) and the reply
 * box. Replaces the customer-requests card; the case actions are unchanged.
 */
export function OrderConversationCard({ order, request }: { order: Order; request?: OrderActionRequest | null }) {
  const t = useMessages(orderDetailMessages);
  const tr = useMessages(inboxMessages);
  const o = useMessages(orderMessages);
  const actions = useOrderActionPermissions();
  const canResolve = actions.canResolveOrderSupportRequests;
  const canRead = useHasPermission(PERMISSIONS.CONVERSATIONS_VIEW);
  const canReply = useHasPermission(PERMISSIONS.CONVERSATIONS_REPLY);
  const cardRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<OrderSupportRequest | null>(null);
  const [open, setOpen] = useState(false);
  const requests = order.supportRequests ?? [];
  const thread = useQuery({ ...orderThreadQueryOptions(order.id), enabled: canRead });
  const markRead = useMarkRead();

  useEffect(() => {
    if (thread.data) markRead(thread.data);
  }, [thread.data, markRead]);

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

  if (!canRead && requests.length === 0) return null;
  const active = requests.filter((item) => item.active);
  const conversation = thread.data ?? null;

  return (
    <Card ref={cardRef} id="order-requests" className="scroll-mt-4">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div className="flex items-center gap-2">
          <CardTitle>{tr("card.title")}</CardTitle>
          {conversation && conversation.unread > 0 ? <Badge variant="info">{tr("unread", { count: conversation.unread })}</Badge> : null}
          {active.length > 0 ? <Badge variant="attention">{t("requests.open", { count: active.length })}</Badge> : null}
        </div>
        {conversation ? (
          <Button variant="link" size="sm" asChild>
            <Link to="/admin/inbox/$conversationId" params={{ conversationId: conversation.id }}>{tr("card.openInInbox")}</Link>
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {requests.length > 0 ? (
          <ul className="divide-y rounded-lg border">
            {requests.map((item) => (
              <li key={item.id} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{o(`request.${item.type}`)}</span>
                    <Badge variant={statusBadgeVariant(item.status)}>{orderDetailLabel(t, "requests.status.", item.status)}</Badge>
                  </div>
                  <p className="text-muted-foreground">{item.reason}</p>
                  <p className="text-muted-foreground">{formatOrderTimestamp(item.submittedAt ?? item.createdAt)}</p>
                </div>
                {canResolve && item.active && resolutionsFor(item, actions.canChangeOrderStatus).length > 0 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSelected(item);
                      setOpen(true);
                    }}
                  >
                    {t("requests.review")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {canRead ? (
          thread.isPending ? (
            <p className="text-body text-muted-foreground">{t("read.loading")}</p>
          ) : thread.isError ? (
            <div className="flex items-center justify-between gap-2">
              <p className="text-body text-muted-foreground">{tr("threadLoadFailed")}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => void thread.refetch()}>{tr("retry")}</Button>
            </div>
          ) : conversation && conversation.messages.length > 0 ? (
            <Suspense fallback={<p className="text-body text-muted-foreground">{t("read.loading")}</p>}>
              <ConversationMessages
                thread={conversation}
                currentUserId={null}
                className="max-h-96 overflow-y-auto"
              />
            </Suspense>
          ) : (
            <div className="flex items-start gap-3">
              <MessagesSquare aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div className="flex flex-col gap-1">
                <p className="font-medium">{tr("card.empty")}</p>
                <p className="text-body text-muted-foreground">{tr("card.emptyBody")}</p>
              </div>
            </div>
          )
        ) : null}
        {canRead && canReply ? (
          <Suspense fallback={null}>
            <div className="border-t pt-4">
              <ConversationComposer conversationId={conversation?.id ?? null} orderId={order.id} />
            </div>
          </Suspense>
        ) : null}
      </CardContent>
      <ResolveDialog order={order} request={selected} open={open} onOpenChange={setOpen} />
    </Card>
  );
}
