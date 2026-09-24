import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Textarea } from "~/components/ui/textarea";
import { useCurrency } from "~/hooks/use-currency";
import { useHydrated } from "~/hooks/use-hydrated";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { orderMessages } from "~/i18n/orders";
import { resourceMessages } from "~/i18n/resource";
import { orderErrorMessage, useAddOrderComment } from "~/lib/api-mutations/orders";
import { orderTimelineQueryOptions } from "~/lib/api-query-options/orders";
import { formatSavedMajorAmount, resolveSavedOrderMoneySummary } from "~/lib/order-tax-presentation";
import { describeTimelineEvent } from "~/lib/order-timeline-display";
import { formatOrderTimestamp } from "./formatters";
import type { Order } from "./types";

const COMMENT_MAX_LENGTH = 2000;

/** Shopify's order timeline: a staff comment box, then what happened, newest first. */
export function OrderTimelineCard({ order }: { order: Order }) {
  const t = useMessages(orderDetailMessages);
  const o = useMessages(orderMessages);
  const r = useMessages(resourceMessages);
  const { fmt } = useCurrency();
  const hydrated = useHydrated();
  const canComment = useOrderActionPermissions().canEditOrders;
  const [comment, setComment] = useState("");
  const query = useQuery({ ...orderTimelineQueryOptions(order.id), enabled: hydrated });
  const mutation = useAddOrderComment();
  const saved = resolveSavedOrderMoneySummary(order);
  const money = (amount: number) => (saved ? formatSavedMajorAmount(amount, saved) : fmt(amount));
  const events = query.data?.events ?? [];

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = comment.trim();
    if (!body) return;
    mutation.mutate({ orderId: order.id, body }, { onSuccess: () => setComment("") });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("timeline.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {canComment ? (
          <form method="post" className="space-y-2" onSubmit={submit}>
            <Textarea
              aria-label={t("timeline.comment")}
              placeholder={t("timeline.commentPlaceholder")}
              value={comment}
              rows={2}
              maxLength={COMMENT_MAX_LENGTH}
              disabled={mutation.isPending}
              onChange={(event) => {
                setComment(event.target.value);
                if (mutation.isError) mutation.reset();
              }}
            />
            <div className="flex items-center justify-between gap-2">
              {mutation.isError ? <p role="alert" className="text-destructive">{orderErrorMessage(mutation.error)}</p> : <span />}
              <Button type="submit" size="sm" disabled={!comment.trim()} loading={mutation.isPending}>
                {t("timeline.post")}
              </Button>
            </div>
          </form>
        ) : null}
        {!hydrated || query.isLoading ? (
          <p className="text-muted-foreground">{t("read.loading")}</p>
        ) : query.isError ? (
          <div className="flex items-center justify-between gap-2">
            <p className="text-muted-foreground">{t("timeline.loadFailed")}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>
              {r("retry")}
            </Button>
          </div>
        ) : events.length === 0 ? (
          <p className="text-muted-foreground">{t("timeline.empty")}</p>
        ) : (
          <ol className="space-y-3 border-l pl-4">
            {events.map((event) => {
              const line = describeTimelineEvent(event, t, o, money);
              const comment = event.kind === "comment";
              return (
                <li key={event.id} className="space-y-0.5">
                  <p className={comment ? "whitespace-pre-wrap break-words" : undefined}>{line.text}</p>
                  {line.detail ? <p className="whitespace-pre-wrap break-words text-muted-foreground">{line.detail}</p> : null}
                  <p className="text-muted-foreground">
                    {[event.actorName, formatOrderTimestamp(event.createdAt)].filter(Boolean).join(" · ")}
                  </p>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
