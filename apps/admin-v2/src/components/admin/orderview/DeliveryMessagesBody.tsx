import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { putApiV1AdminOrdersByIdItemsByItemIdDeliveryMessage } from "@scalius/api-client/sdk";
import { toast } from "~/lib/toast";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useMessages } from "~/i18n";
import { orderDeliveryMessageMessages } from "~/i18n/order-delivery-message";
import { resourceMessages } from "~/i18n/resource";
import { apiData } from "~/lib/api";
import { invalidateOrder, orderErrorMessage } from "~/lib/api-mutations/orders";
import { useCommand } from "~/lib/use-command";
import { DeliveryMessageDialog, type SaveMessage } from "./DeliveryMessageDialog";
import type { MessageLine } from "./delivery-messages";
import { formatOrderTimestamp } from "./formatters";

/**
 * The order's delivery messages, one per line (a split kit pair shows once):
 * whether it has one, a link, when it changed; Add, Edit and Remove. The text
 * itself is never here: the dialog reads it back when staff edit.
 */
export function DeliveryMessagesBody({ orderId, lines }: { orderId: string; lines: MessageLine[] }) {
  const t = useMessages(orderDeliveryMessageMessages);
  const r = useMessages(resourceMessages);
  const queryClient = useQueryClient();
  // Each opening is a new session, so a reopened dialog never shows an earlier draft.
  const [editing, setEditing] = useState<{ session: number; itemId: string } | null>(null);
  const sessions = useRef(0);
  const lastEditing = useRef(editing);
  if (editing) lastEditing.current = editing;
  const [removing, setRemoving] = useState<string | null>(null);

  const save = useCommand({
    subject: (input: SaveMessage) => input.itemId,
    mutationFn: (input: SaveMessage) =>
      apiData(putApiV1AdminOrdersByIdItemsByItemIdDeliveryMessage({
        path: { id: orderId, itemId: input.itemId },
        body: { message: input.message, expectedRevision: input.expectedRevision },
      })),
  });
  const open = (itemId: string) => setEditing({ session: ++sessions.current, itemId });
  const removeLine = lines.find((line) => line.item.id === removing);
  const editLine = lines.find((line) => line.item.id === (editing ?? lastEditing.current)?.itemId);
  const nameOf = (line: MessageLine) => line.item.productName || t("unnamedProduct");

  return (
    <Card data-testid="delivery-messages">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("note")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {lines.map((line) => (
            <li key={line.item.id} className="flex flex-wrap items-start justify-between gap-2 py-3 text-body first:pt-0 last:pb-0">
              <div className="min-w-0 break-words">
                <p className="font-medium">{nameOf(line)}</p>
                {line.item.variantLabel ? <p className="text-muted-foreground">{line.item.variantLabel}</p> : null}
                {line.message ? (
                  <p className="text-muted-foreground">
                    {[
                      t("messageForBuyer"),
                      line.message.hasLink ? t("hasLink") : null,
                      t("updated", { date: formatOrderTimestamp(line.message.updatedAt) ?? "" }),
                    ].filter(Boolean).join(" · ")}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {line.message ? (
                  <>
                    <Button type="button" variant="outline" size="sm" onClick={() => open(line.item.id)}>{t("edit")}</Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setRemoving(line.item.id)}>{t("remove")}</Button>
                  </>
                ) : (
                  <Button type="button" variant="outline" size="sm" onClick={() => open(line.item.id)}>{t("add")}</Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
      <DeliveryMessageDialog
        open={editing !== null}
        session={lastEditing.current?.session ?? 0}
        orderId={orderId}
        line={editLine ?? null}
        save={save}
        onClose={() => setEditing(null)}
        onSaved={() => {
          toast.success(t("saved"));
          void invalidateOrder(queryClient, orderId);
        }}
        onConflict={() => void invalidateOrder(queryClient, orderId)}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={save.guardClose((next) => { if (!next) setRemoving(null); })}
        title={t("removeTitle", { name: removeLine ? nameOf(removeLine) : "" })}
        description={t("removeBody")}
        confirmLabel={t("remove")}
        cancelLabel={r("cancel")}
        isLoading={save.isPending}
        onConfirm={() => {
          if (!removeLine?.message) return;
          save.mutate({ itemId: removeLine.item.id, message: null, expectedRevision: removeLine.message.revision }, {
            onSuccess: () => {
              setRemoving(null);
              toast.success(t("removed"));
              void invalidateOrder(queryClient, orderId);
            },
            onError: (error) => {
              setRemoving(null);
              toast.error(orderErrorMessage(error));
              // Someone else changed or removed it: show the order as it is now.
              void invalidateOrder(queryClient, orderId);
            },
          });
        }}
      />
    </Card>
  );
}
