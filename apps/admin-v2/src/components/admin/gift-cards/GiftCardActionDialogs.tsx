import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { GIFT_CARD_LIMITS } from "@scalius/core/modules/gift-cards/browser";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { MoneyInput } from "~/components/admin/shared/MoneyInput";
import { useDirtyDialogClose } from "~/components/admin/shared/use-dirty-dialog-close";
import { Alert, AlertDescription } from "~/components/ui/alert";
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
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { Textarea } from "~/components/ui/textarea";
import { translate, useMessages } from "~/i18n";
import { giftCardsMessages, type GiftCardMessageKey } from "~/i18n/gift-cards";
import { isAdminApiConflictError } from "~/lib/admin-api-error";
import { getServerFnError } from "~/lib/api-helpers";
import type { GiftCardDetail } from "~/lib/api-query-options/gift-cards";
import { GiftCardCustomerPicker } from "./GiftCardCustomerPicker";
import { fieldDescribedBy, GiftCardField } from "./gift-card-fields";
import { adjustmentFor, type AdjustDirection, type AdjustErrors } from "./gift-card-drafts";
import {
  formatGiftCardMoney,
  giftCardExpiresAtFromDay,
  giftCardLastDay,
  isValidExpiryDay,
  todayStoreDay,
} from "./gift-card-format";
import { useAdjustGiftCard, useUpdateGiftCard } from "./use-gift-card-mutations";

/**
 * What a failed gift-card write says. A 409 is the version check: someone
 * changed the card, which has been reloaded (the mutations refetch it).
 */
export function giftCardErrorText(error: unknown, fallback: GiftCardMessageKey): string {
  if (isAdminApiConflictError(error)) return translate(giftCardsMessages, "conflict");
  return getServerFnError(error, translate(giftCardsMessages, fallback));
}

/**
 * The shell every card action shares: title, help, an error banner, the form and a
 * two-button footer. Closing with unsaved edits (Esc, outside click, Cancel) asks first.
 */
function ActionDialog({ open, onOpenChange, busy, dirty, formId, title, description, error, submitLabel, onSubmit, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  /** The form differs from what the dialog opened with. */
  dirty: boolean;
  formId: string;
  title: string;
  description?: string;
  error: string | null;
  submitLabel: string;
  onSubmit: () => void;
  children: ReactNode;
}) {
  const t = useMessages(giftCardsMessages);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!busy) onSubmit();
  };
  const { requestClose, discardDialog } = useDirtyDialogClose({ dirty, busy, onClose: () => onOpenChange(false) });
  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <form id={formId} method="post" noValidate className="space-y-4" onSubmit={submit}>
            {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
            {children}
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={requestClose}>{t("cancel")}</Button>
            <Button type="submit" form={formId} loading={busy}>{submitLabel}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog {...discardDialog} />
    </>
  );
}

/** Add or remove value with a required reason; one request key per opening, so a retry adds nothing twice. */
export function AdjustBalanceDialog({ card, open, onOpenChange }: {
  card: GiftCardDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(giftCardsMessages);
  const [direction, setDirection] = useState<AdjustDirection>("increase");
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<AdjustErrors>({});
  const requestKey = useRef("");
  const mutation = useAdjustGiftCard(card.id);
  const reset = mutation.reset;

  useEffect(() => {
    if (!open) return;
    setDirection("increase");
    setAmount(null);
    setReason("");
    setErrors({});
    requestKey.current = crypto.randomUUID();
    reset();
  }, [open, reset]);

  const result = adjustmentFor({ direction, amount, reason }, card);
  const preview = "deltaMinor" in result ? card.balanceMinor + result.deltaMinor : null;
  const shown = (field: "amount" | "reason") => (errors[field] ? t(errors[field]!) : undefined);

  const submit = () => {
    if ("errors" in result) {
      setErrors(result.errors);
      document.getElementById(result.errors.amount ? "gift-card-adjust-amount" : "gift-card-adjust-reason")?.focus();
      return;
    }
    mutation.mutate(
      { requestKey: requestKey.current, ...result.body },
      {
        onSuccess: () => {
          toast.success(t("adjusted"));
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <ActionDialog
      open={open}
      onOpenChange={onOpenChange}
      busy={mutation.isPending}
      dirty={direction !== "increase" || amount !== null || reason !== ""}
      formId="gift-card-adjust"
      title={t("adjustBalance")}
      description={t("adjustHelp")}
      error={mutation.isError ? giftCardErrorText(mutation.error, "saveFailed") : null}
      submitLabel={t("save")}
      onSubmit={submit}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <GiftCardField id="gift-card-adjust-direction" label={t("direction")}>
          <SearchableSelect
            id="gift-card-adjust-direction"
            value={direction}
            disabled={mutation.isPending}
            onValueChange={(value) => {
              setDirection(value === "decrease" ? "decrease" : "increase");
              setErrors((current) => ({ ...current, amount: undefined }));
            }}
            triggerClassName="w-full"
            options={[{ value: "increase", label: t("increase") }, { value: "decrease", label: t("decrease") }]}
          />
        </GiftCardField>
        <GiftCardField id="gift-card-adjust-amount" label={t("amount")} error={shown("amount")}>
          <MoneyInput
            id="gift-card-adjust-amount"
            currencyCode={card.currencyCode}
            value={amount}
            disabled={mutation.isPending}
            aria-invalid={errors.amount ? true : undefined}
            aria-describedby={fieldDescribedBy("gift-card-adjust-amount", shown("amount"), false)}
            onValueChange={(value) => {
              setAmount(value);
              setErrors((current) => ({ ...current, amount: undefined }));
            }}
          />
        </GiftCardField>
      </div>
      <p className="text-body tabular-nums text-muted-foreground" aria-live="polite">
        {t("newBalance", { amount: formatGiftCardMoney(preview ?? card.balanceMinor, card.currencyCode) })}
      </p>
      <GiftCardField id="gift-card-adjust-reason" label={t("reason")} help={t("reasonHelp")} error={shown("reason")}>
        <Textarea
          id="gift-card-adjust-reason"
          value={reason}
          rows={2}
          maxLength={GIFT_CARD_LIMITS.maxNoteLength}
          disabled={mutation.isPending}
          aria-invalid={errors.reason ? true : undefined}
          aria-describedby={fieldDescribedBy("gift-card-adjust-reason", shown("reason"), true)}
          onChange={(event) => {
            setReason(event.target.value);
            setErrors((current) => ({ ...current, reason: undefined }));
          }}
        />
      </GiftCardField>
    </ActionDialog>
  );
}

/** Extend, change or remove the expiry (the card's `version` guards against a stale edit). */
export function ExpiryDialog({ card, open, onOpenChange }: {
  card: GiftCardDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(giftCardsMessages);
  const [mode, setMode] = useState<"never" | "date">("never");
  const [day, setDay] = useState("");
  const [invalid, setInvalid] = useState(false);
  const mutation = useUpdateGiftCard(card.id);
  const reset = mutation.reset;

  useEffect(() => {
    if (!open) return;
    const lastDay = giftCardLastDay(card.expiresAt);
    setMode(lastDay ? "date" : "never");
    setDay(lastDay ?? "");
    setInvalid(false);
    reset();
    // Each opening starts from the saved expiry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reset]);

  const submit = () => {
    const expiresAt = mode === "never" ? null : isValidExpiryDay(day) ? giftCardExpiresAtFromDay(day) : null;
    if (mode === "date" && expiresAt === null) {
      setInvalid(true);
      document.getElementById("gift-card-expiry-day")?.focus();
      return;
    }
    mutation.mutate(
      { version: card.version, expiresAt },
      {
        onSuccess: () => {
          toast.success(t("expirySaved"));
          onOpenChange(false);
        },
      },
    );
  };

  const error = invalid ? t("expiryInvalid") : undefined;
  const savedDay = giftCardLastDay(card.expiresAt) ?? "";
  const dirty = savedDay ? mode !== "date" || day !== savedDay : mode !== "never";
  return (
    <ActionDialog
      open={open}
      onOpenChange={onOpenChange}
      busy={mutation.isPending}
      dirty={dirty}
      formId="gift-card-expiry-form"
      title={t("expiryTitle")}
      description={t("expiryDialogHelp")}
      error={mutation.isError ? giftCardErrorText(mutation.error, "saveFailed") : null}
      submitLabel={t("save")}
      onSubmit={submit}
    >
      <RadioGroup
        value={mode}
        disabled={mutation.isPending}
        aria-label={t("expires")}
        onValueChange={(value) => {
          setMode(value === "date" ? "date" : "never");
          setInvalid(false);
        }}
      >
        <div className="flex items-center gap-3">
          <RadioGroupItem id="gift-card-expiry-never" value="never" />
          <Label htmlFor="gift-card-expiry-never">{t("neverExpires")}</Label>
        </div>
        <div className="flex items-center gap-3">
          <RadioGroupItem id="gift-card-expiry-date" value="date" />
          <Label htmlFor="gift-card-expiry-date">{t("setExpiry")}</Label>
        </div>
      </RadioGroup>
      {mode === "date" ? (
        <GiftCardField id="gift-card-expiry-day" label={t("expiryDate")} help={t("expiryHelp")} error={error}>
          <Input
            id="gift-card-expiry-day"
            type="date"
            min={todayStoreDay()}
            value={day}
            disabled={mutation.isPending}
            aria-invalid={invalid ? true : undefined}
            aria-describedby={fieldDescribedBy("gift-card-expiry-day", error, true)}
            onChange={(event) => {
              setDay(event.target.value);
              setInvalid(false);
            }}
          />
        </GiftCardField>
      ) : null}
    </ActionDialog>
  );
}

/** Who the card belongs to and the staff note. Only what changed is sent. */
export function EditDetailsDialog({ card, open, onOpenChange }: {
  card: GiftCardDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(giftCardsMessages);
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(card.customer);
  const [note, setNote] = useState(card.note ?? "");
  const mutation = useUpdateGiftCard(card.id);
  const reset = mutation.reset;

  useEffect(() => {
    if (!open) return;
    setCustomer(card.customer);
    setNote(card.note ?? "");
    reset();
    // Each opening starts from the saved card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reset]);

  const customerId = customer?.id ?? null;
  const nextNote = note.trim() || null;
  const changes = {
    ...(customerId !== (card.customer?.id ?? null) ? { customerId } : {}),
    ...(nextNote !== (card.note ?? null) ? { note: nextNote } : {}),
  };
  const submit = () => {
    if (Object.keys(changes).length === 0) {
      onOpenChange(false);
      return;
    }
    mutation.mutate(
      { version: card.version, ...changes },
      {
        onSuccess: () => {
          toast.success(t("detailsSaved"));
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <ActionDialog
      open={open}
      onOpenChange={onOpenChange}
      busy={mutation.isPending}
      dirty={Object.keys(changes).length > 0}
      formId="gift-card-details"
      title={t("editDetailsTitle")}
      error={mutation.isError ? giftCardErrorText(mutation.error, "saveFailed") : null}
      submitLabel={t("save")}
      onSubmit={submit}
    >
      <GiftCardField id="gift-card-edit-customer" label={t("customer")} help={t("customerHelp")}>
        <GiftCardCustomerPicker
          id="gift-card-edit-customer"
          value={customer?.id ?? ""}
          selectedLabel={customer?.name}
          disabled={mutation.isPending}
          describedBy="gift-card-edit-customer-help"
          onChange={setCustomer}
        />
      </GiftCardField>
      <GiftCardField id="gift-card-edit-note" label={t("note")} help={t("noteHelp")}>
        <Textarea
          id="gift-card-edit-note"
          value={note}
          rows={3}
          maxLength={GIFT_CARD_LIMITS.maxNoteLength}
          disabled={mutation.isPending}
          aria-describedby="gift-card-edit-note-help"
          onChange={(event) => setNote(event.target.value)}
        />
      </GiftCardField>
    </ActionDialog>
  );
}
