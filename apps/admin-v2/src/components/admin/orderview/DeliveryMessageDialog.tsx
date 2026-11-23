import { useEffect, useState } from "react";
import { postApiV1AdminOrdersByIdItemsByItemIdDeliveryMessageReveal } from "@scalius/api-client/sdk";
import { ORDER_LINE_MESSAGE_TEXT_MAX, readOrderLineMessageDraft } from "@scalius/shared/order-line-message";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { useMessages } from "~/i18n";
import { orderDeliveryMessageMessages } from "~/i18n/order-delivery-message";
import { resourceMessages } from "~/i18n/resource";
import { apiData } from "~/lib/api";
import { readAdminApiError } from "~/lib/admin-api-error";
import { orderErrorMessage } from "~/lib/api-mutations/orders";
import type { Command } from "~/lib/use-command";
import type { MessageLine } from "./delivery-messages";

export interface SaveMessage {
  itemId: string;
  /** null removes the message. */
  message: { text: string; link: string | null } | null;
  /** The revision the staff member saw (0 when the line had no message). */
  expectedRevision: number;
}

type Refusal = keyof typeof orderDeliveryMessageMessages.en;
const REASONS = new Set([
  "message_text_required",
  "message_text_too_long",
  "message_text_control_characters",
  "message_link_not_https",
  "message_link_too_long",
]);

/**
 * Add or edit one line's delivery message. The text is read back (revealed)
 * when an edit opens and lives only in this component's state: no query cache,
 * no storage, no URL, no log. The form mounts with each opening and unmounts
 * when the dialog is gone, so a closed dialog holds nothing.
 */
export function DeliveryMessageDialog({ open, session, orderId, line, save, onClose, onSaved, onConflict }: {
  open: boolean;
  /** A new one for each opening: the form starts fresh. */
  session: number;
  orderId: string;
  line: MessageLine | null;
  save: Command<SaveMessage, unknown>;
  onClose: () => void;
  onSaved: () => void;
  /** Someone else changed the message: the order is read again. */
  onConflict: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={save.guardClose((next) => { if (!next) onClose(); })}>
      <DialogContent>
        {line ? <MessageForm key={`${session}:${line.item.id}`} orderId={orderId} line={line} save={save} onClose={onClose} onSaved={onSaved} onConflict={onConflict} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function MessageForm({ orderId, line, save, onClose, onSaved, onConflict }: {
  orderId: string;
  line: MessageLine;
  save: Command<SaveMessage, unknown>;
  onClose: () => void;
  onSaved: () => void;
  onConflict: () => void;
}) {
  const t = useMessages(orderDeliveryMessageMessages);
  const r = useMessages(resourceMessages);
  const itemId = line.item.id;
  // Fixed when the form opens: a message someone else adds meanwhile never replaces the draft.
  const [editing] = useState(line.message !== null);
  const [text, setText] = useState("");
  const [link, setLink] = useState("");
  // Reading the current message back: an edit waits for it, an add has nothing to read.
  const [state, setState] = useState<"loading" | "ready" | "failed">(editing ? "loading" : "ready");
  const [errors, setErrors] = useState<{ text?: string; link?: string; form?: string }>({});

  useEffect(() => {
    if (!editing) return;
    let current = true;
    apiData(postApiV1AdminOrdersByIdItemsByItemIdDeliveryMessageReveal({ path: { id: orderId, itemId } }))
      .then((revealed) => {
        if (!current) return;
        setText(revealed.text ?? "");
        setLink(revealed.link ?? "");
        setState("ready");
      })
      .catch(() => { if (current) setState("failed"); });
    return () => { current = false; };
  }, [editing, orderId, itemId]);

  const refusal = (error: Error) => {
    const api = readAdminApiError(error);
    const details = api?.details as { reason?: unknown; field?: unknown } | undefined;
    if (api?.status === 409) {
      onConflict();
      return { form: t("conflict") };
    }
    if (api?.status === 400 && typeof details?.reason === "string" && REASONS.has(details.reason)) {
      const message = t(`reason.${details.reason}` as Refusal, { max: ORDER_LINE_MESSAGE_TEXT_MAX });
      return details.field === "link" || details.reason.startsWith("message_link") ? { link: message } : { text: message };
    }
    return { form: orderErrorMessage(error) };
  };

  const submit = () => {
    const draft = readOrderLineMessageDraft({ text, link });
    if (!draft.ok) {
      setErrors({ [draft.field]: t(`reason.${draft.reason}` as Refusal, { max: ORDER_LINE_MESSAGE_TEXT_MAX }) });
      return;
    }
    setErrors({});
    save.mutate({ itemId, message: draft.body, expectedRevision: line.message?.revision ?? 0 }, {
      onSuccess: () => {
        onSaved();
        onClose();
      },
      onError: (error) => setErrors(refusal(error)),
    });
  };

  const characters = Array.from(text).length;
  const busy = state === "loading";
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t(editing ? "editTitle" : "addTitle")}</DialogTitle>
        <DialogDescription>{t("dialogHelp", { name: line.item.productName || t("unnamedProduct") })}</DialogDescription>
      </DialogHeader>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (state === "ready") submit();
        }}
      >
        {state === "failed" ? <Alert variant="destructive"><AlertDescription>{t("revealFailed")}</AlertDescription></Alert> : null}
        {errors.form ? <Alert variant="destructive"><AlertDescription>{errors.form}</AlertDescription></Alert> : null}
        <div className="space-y-1">
          <Field id="delivery-message-text" label={t("textLabel")} error={errors.text}>
            <Textarea
              id="delivery-message-text"
              rows={6}
              value={text}
              disabled={state !== "ready"}
              placeholder={busy ? t("loading") : t("textPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          <p className="text-end text-muted-foreground tabular-nums">{t("textCounter", { count: characters, max: ORDER_LINE_MESSAGE_TEXT_MAX })}</p>
        </div>
        <Field id="delivery-message-link" label={t("linkLabel")} optional help={t("linkHelp")} error={errors.link}>
          <Input
            id="delivery-message-link"
            type="url"
            inputMode="url"
            value={link}
            disabled={state !== "ready"}
            placeholder={t("linkPlaceholder")}
            autoComplete="off"
            onChange={(event) => setLink(event.target.value)}
          />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>{r("cancel")}</Button>
          <Button type="submit" loading={save.isPending} disabled={state !== "ready"}>{t("save")}</Button>
        </DialogFooter>
      </form>
    </>
  );
}
