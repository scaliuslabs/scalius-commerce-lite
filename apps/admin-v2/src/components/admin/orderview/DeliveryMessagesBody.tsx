import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  postApiV1AdminOrdersByIdItemsByItemIdDeliveryMessageReveal,
  putApiV1AdminOrdersByIdItemsByItemIdDeliveryMessage,
} from "@scalius/api-client/sdk";
import { toast } from "~/lib/toast";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useMessages } from "~/i18n";
import { orderDeliveryMessageMessages } from "~/i18n/order-delivery-message";
import { resourceMessages } from "~/i18n/resource";
import { apiData } from "~/lib/api";
import { invalidateOrder, orderErrorMessage, useOrderCommand } from "~/lib/api-mutations/orders";
import { DeliveryMessageDialog, type RevealedMessage, type SaveMessage } from "./DeliveryMessageDialog";
import { messagesExpectedOn, type MessageLine } from "./delivery-messages";
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
  // An order of parcels only opens closed: one press lists its lines.
  const [listed, setListed] = useState(() => messagesExpectedOn(lines));

  // An order command: once it lands the order is read again (its card, its timeline line).
  const save = useOrderCommand({
    order: () => orderId,
    subject: (input: SaveMessage) => input.itemId,
    mutationFn: (input: SaveMessage) =>
      apiData(putApiV1AdminOrdersByIdItemsByItemIdDeliveryMessage({
        path: { id: orderId, itemId: input.itemId },
        body: { message: input.message, expectedRevision: input.expectedRevision },
      })),
  });
  // The text read back for one opening, in component state only (the command itself returns nothing).
  const [revealed, setRevealed] = useState<(RevealedMessage & { session: number }) | null>(null);
  const [revealFailed, setRevealFailed] = useState<number | null>(null);
  // Reading a message back is an order command too: the server writes who read it on the timeline,
  // so the order is read again and the line shows without a reload. It runs once per Edit press.
  const reveal = useOrderCommand({
    order: () => orderId,
    subject: (input: { itemId: string; session: number }) => `${input.itemId}:${input.session}`,
    mutationFn: async (input: { itemId: string; session: number }) => {
      const body = await apiData(postApiV1AdminOrdersByIdItemsByItemIdDeliveryMessageReveal({ path: { id: orderId, itemId: input.itemId } }));
      if (sessions.current === input.session) setRevealed({ session: input.session, text: body.text ?? "", link: body.link ?? "" });
      return null;
    },
  });
  const open = (line: MessageLine) => {
    const session = ++sessions.current;
    setRevealed(null);
    setRevealFailed(null);
    setEditing({ session, itemId: line.item.id });
    if (line.message) reveal.mutate({ itemId: line.item.id, session }, { onError: () => setRevealFailed(session) });
  };
  const close = () => {
    setEditing(null);
    // Nothing of the text stays once the dialog is gone.
    setRevealed(null);
  };
  const removeLine = lines.find((line) => line.item.id === removing);
  const editLine = lines.find((line) => line.item.id === (editing ?? lastEditing.current)?.itemId);
  const nameOf = (line: MessageLine) => line.item.productName || t("unnamedProduct");

  return (
    <Card data-testid="delivery-messages">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t(listed ? "note" : "closedNote")}</CardDescription>
      </CardHeader>
      {!listed ? (
        <CardContent>
          <Button type="button" variant="outline" size="sm" onClick={() => setListed(true)}>{t("showLines")}</Button>
        </CardContent>
      ) : (
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
                    <Button type="button" variant="outline" size="sm" onClick={() => open(line)}>{t("edit")}</Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setRemoving(line.item.id)}>{t("remove")}</Button>
                  </>
                ) : (
                  <Button type="button" variant="outline" size="sm" onClick={() => open(line)}>{t("add")}</Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
      )}
      <DeliveryMessageDialog
        open={editing !== null}
        session={lastEditing.current?.session ?? 0}
        line={editLine ?? null}
        revealed={revealed && revealed.session === editing?.session ? revealed : null}
        revealFailed={revealFailed !== null && revealFailed === editing?.session}
        save={save}
        onClose={close}
        onSaved={() => toast.success(t("saved"))}
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
