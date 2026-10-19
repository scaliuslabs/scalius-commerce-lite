import { InlineError } from "~/components/admin/states/InlineError";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MessagesSquare } from "lucide-react";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useMessages } from "~/i18n";
import { orderConversationMessages } from "~/i18n/order-conversation";
import { orderDetailLabel, orderDetailMessages } from "~/i18n/order-detail";
import { orderMessages } from "~/i18n/orders";
import { formatOrderTimestamp } from "./formatters";
import { openCancellationRequest, type OrderActionRequest } from "./primary-action";
import { statusBadgeVariant } from "./status-badges";
import type { Order, OrderSupportRequest } from "./types";
import { resolutionsFor } from "./request-resolutions";
import { orderThreadQueryOptions } from "~/lib/api-query-options/inbox";
import type { ConversationFollowRequest } from "../inbox/ConversationMessages";
import { useMarkRead } from "../inbox/inbox-api";
import { useStoreOwnerName } from "../states/store-owner";

export { resolutionsFor } from "./request-resolutions";

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
const ResolveDialog = lazy(() => import("./OrderRequestResolveDialog").then((module) => ({ default: module.ResolveDialog })));
const ConversationComposer = lazy(() =>
  loadConversationComposer().then((module) => ({ default: module.ConversationComposer })),
);

export function OrderConversationCard({ order, request }: { order: Order; request?: OrderActionRequest | null }) {
  const t = useMessages(orderDetailMessages);
  const tr = useMessages(orderConversationMessages);
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
  // Staff who see the buyer's words in a request but can't open the thread are told why.
  const ownerName = useStoreOwnerName(!canRead || !canReply);

  const [followRequest, setFollowRequest] = useState<ConversationFollowRequest>();
  const onReadFrontier = useCallback((seq: number) => {
    if (thread.data) markRead(thread.data, seq);
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
            <InlineError title={tr("threadLoadFailed")} error={thread.error} onRetry={() => void thread.refetch()} />
          ) : conversation && conversation.messages.length > 0 ? (
            <Suspense fallback={<p className="text-body text-muted-foreground">{t("read.loading")}</p>}>
              <ConversationMessages
                thread={conversation}
                currentUserId={null}
                active={!open}
                onReadFrontier={onReadFrontier}
                followRequest={followRequest}
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
        {!canRead ? (
          <p className="text-body text-muted-foreground">
            {tr("card.noAccess")} {ownerName ? tr("card.askNamed", { name: ownerName }) : tr("card.askOwner")}
          </p>
        ) : !canReply ? (
          <p className="border-t pt-4 text-body text-muted-foreground">
            {tr("card.readOnly")} {ownerName ? tr("card.askNamed", { name: ownerName }) : tr("card.askOwner")}
          </p>
        ) : null}
        {canRead && canReply ? (
          <Suspense fallback={null}>
            <div className="border-t pt-4">
              <ConversationComposer key={order.id} onPosted={(posted) => setFollowRequest({ conversationId: posted.id, seq: posted.messages.at(-1)?.seq ?? 0 })} primary={false} allowInternalNotes={!actions.canEditOrders} conversationId={conversation?.id ?? null} orderId={order.id} />
            </div>
          </Suspense>
        ) : null}
      </CardContent>
      {selected ? (
        <Suspense fallback={null}>
          <ResolveDialog order={order} request={selected} open={open} onOpenChange={setOpen} />
        </Suspense>
      ) : null}
    </Card>
  );
}
